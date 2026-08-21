import { promises as fs } from "node:fs";
import path from "node:path";
import type { Finding } from "../evidence/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AiProviderRequest = {
  prompt: string;
  maxTokens?: number;
};

export type AiProviderResponse = {
  content: string;
};

/**
 * Injected provider abstraction. Implementations call an LLM API;
 * tests inject a mock. The provider is never imported directly —
 * the caller always passes an instance.
 */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete(request: AiProviderRequest): Promise<AiProviderResponse>;
}

export type FindingClassification = {
  /** Matches Finding.location — "relative/path:line" */
  location: string;
  /** Matches Finding.findingType */
  findingType: string;
  classification: "positive_evidence" | "reference_only" | "negative_evidence";
  reasoning: string;
  confidence: number;
};

export type ClassificationResult = {
  classifiedAt: string;
  provider: string;
  model: string;
  classifications: FindingClassification[];
};

export type ClassifyInput = {
  findings: Finding[];
  /** Resolved absolute path of the scan root directory. */
  targetPath: string;
  /** Number of lines of context before and after each finding (default 3). */
  contextLines?: number;
};

// ---------------------------------------------------------------------------
// Context extraction
// ---------------------------------------------------------------------------

/**
 * Parse a Finding.location ("relative/path:line") into its components.
 * Returns null if the format is unexpected.
 */
export function parseLocation(location: string): {
  relativePath: string;
  line: number;
} | null {
  const lastColon = location.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const line = Number(location.slice(lastColon + 1));
  if (!Number.isFinite(line) || line < 1) return null;
  return { relativePath: location.slice(0, lastColon), line };
}

/**
 * Extract surrounding context lines for a finding from a file's content.
 * `lines` is the full file split by newline. `lineNo` is 1-indexed.
 */
export function extractContext(
  lines: string[],
  lineNo: number,
  contextLines: number,
): string[] {
  const start = Math.max(0, lineNo - 1 - contextLines);
  const end = Math.min(lines.length, lineNo - 1 + contextLines + 1);
  return lines.slice(start, end);
}

// ---------------------------------------------------------------------------
// File reading for context
// ---------------------------------------------------------------------------

/**
 * Read a file and return its lines, or null if unreadable.
 */
async function readFileLines(absolutePath: string): Promise<string[] | null> {
  try {
    const content = await fs.readFile(absolutePath, "utf8");
    return content.split(/\r?\n/);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

type FindingWithContext = {
  finding: Finding;
  contextLines: string[];
};

/**
 * Group findings by their source file, read each file once,
 * and extract context for each finding.
 *
 * CONFIG files are skipped (may contain secrets/.env values).
 */
async function gatherContext(
  findings: Finding[],
  targetPath: string,
  contextLines: number,
): Promise<Map<string, FindingWithContext[]>> {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    // Skip CONFIG files — they may contain API keys, tokens, etc.
    if (f.sourceType === "CONFIG") continue;
    const parsed = parseLocation(f.location);
    if (!parsed) continue;
    if (!byFile.has(parsed.relativePath)) byFile.set(parsed.relativePath, []);
    byFile.get(parsed.relativePath)!.push(f);
  }

  const result = new Map<string, FindingWithContext[]>();

  for (const [relPath, fileFindings] of byFile) {
    const absPath = path.resolve(targetPath, relPath);
    const lines = await readFileLines(absPath);
    if (!lines) continue; // file deleted since scan — skip gracefully

    const items: FindingWithContext[] = [];
    for (const finding of fileFindings) {
      const parsed = parseLocation(finding.location);
      if (!parsed) continue;
      items.push({
        finding,
        contextLines: extractContext(lines, parsed.line, contextLines),
      });
    }
    if (items.length > 0) result.set(relPath, items);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the classification prompt for a batch of findings from one file.
 */
function buildPrompt(
  relPath: string,
  items: FindingWithContext[],
): string {
  const blocks = items
    .map(
      (item, i) =>
        `<finding index="${i + 1}">\n` +
        `location: ${item.finding.location}\n` +
        `findingType: ${item.finding.findingType}\n` +
        `excerpt: ${item.finding.excerpt ?? "(none)"}\n` +
        `context:\n${item.contextLines.map((l, j) => `  ${j + 1}: ${l}`).join("\n")}\n` +
        `</finding>`,
    )
    .join("\n\n");

  return [
    "You are an evidence classifier for DPDP (Digital Personal Data Protection) compliance scanning.",
    "You examine code excerpts around regex-matched findings and classify each match.",
    "",
    "For each finding, classify it as one of:",
    "- positive_evidence: the code/document actually implements or contains the DPDP concept",
    "- reference_only: the code mentions the concept but does not implement it (TODO comments, variable names, documentation references)",
    "- negative_evidence: the code explicitly states the concept is NOT present or NOT implemented",
    "",
    "Respond with ONLY a JSON array. No markdown fences, no explanation text.",
    'Each element: {"location":"...","findingType":"...","classification":"...","reasoning":"...","confidence":0.0-1.0}',
    "",
    `File: ${relPath}`,
    "",
    blocks,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const VALID_CLASSIFICATIONS = new Set([
  "positive_evidence",
  "reference_only",
  "negative_evidence",
]);

/**
 * Parse the raw LLM response into FindingClassification[].
 * Tolerates markdown fences and leading/trailing text around the JSON.
 */
export function parseClassificationResponse(
  raw: string,
): FindingClassification[] {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  // Try to find a JSON array in the response
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const results: FindingClassification[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (
      typeof obj.location !== "string" ||
      typeof obj.findingType !== "string" ||
      typeof obj.classification !== "string" ||
      !VALID_CLASSIFICATIONS.has(obj.classification) ||
      typeof obj.reasoning !== "string"
    ) {
      continue;
    }
    const confidence =
      typeof obj.confidence === "number" &&
      obj.confidence >= 0 &&
      obj.confidence <= 1
        ? obj.confidence
        : 0.5;
    results.push({
      location: obj.location,
      findingType: obj.findingType,
      classification: obj.classification as FindingClassification["classification"],
      reasoning: obj.reasoning,
      confidence,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider (fetch-based, no SDK dependency)
// ---------------------------------------------------------------------------

export type OpenAiCompatibleProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
};

/**
 * Create a provider that calls any OpenAI-compatible API using native fetch.
 * Works with Groq, OpenAI, or any compatible endpoint.
 */
export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleProviderOptions,
): AiProvider {
  const baseUrl = (
    options.baseUrl ?? "https://api.groq.com/openai/v1"
  ).replace(/\/$/, "");
  const model = options.model ?? "allam-2-7b";
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    name: "groq",
    model,
    async complete(request: AiProviderRequest): Promise<AiProviderResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: request.prompt }],
            temperature: 0,
            max_tokens: request.maxTokens ?? 2048,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(
            `AI API returned ${res.status}: ${text.slice(0, 200)}`,
          );
        }
        const body = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = body.choices?.[0]?.message?.content ?? "";
        return { content };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// Keep the old name as a re-export for backward compatibility.
export const createOpenAiProvider = createOpenAiCompatibleProvider;
export type OpenAiProviderOptions = OpenAiCompatibleProviderOptions;

/**
 * Read environment variables and create a Groq provider, or return null
 * if the required GROQ_API_KEY is missing.
 *
 * Configuration:
 *   GROQ_API_KEY   (required) — Groq API key
 *   GROQ_BASE_URL  (optional) — defaults to https://api.groq.com/openai/v1
 *   GROQ_MODEL     (optional) — defaults to allam-2-7b
 */
export function createProviderFromEnv(): AiProvider | null {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  return createOpenAiCompatibleProvider({
    apiKey,
    baseUrl: process.env.GROQ_BASE_URL,
    model: process.env.GROQ_MODEL,
  });
}

// ---------------------------------------------------------------------------
// Main classification function
// ---------------------------------------------------------------------------

export type ClassifyOptions = {
  /** Lines of context above/below each finding (default 3). */
  contextLines?: number;
};

/**
 * Classify existing regex findings using an LLM provider.
 *
 * - Skips CONFIG files entirely (privacy).
 * - Groups findings by source file and batches them per file.
 * - Returns a ClassificationResult to be stored in ScanState.extra.aiContext.
 * - Never throws — errors are returned as empty classifications.
 */
export async function classifyFindings(
  input: ClassifyInput,
  provider: AiProvider,
  options?: ClassifyOptions,
): Promise<ClassificationResult> {
  const contextLines = options?.contextLines ?? 3;
  const byFile = await gatherContext(input.findings, input.targetPath, contextLines);

  // Build a set of valid input finding keys to prevent fabricated locations.
  const validKeys = new Set(
    input.findings.map((f) => `${f.location}|${f.findingType}`),
  );

  const allClassifications: FindingClassification[] = [];

  for (const [relPath, items] of byFile) {
    try {
      const prompt = buildPrompt(relPath, items);
      const response = await provider.complete({ prompt });
      const parsed = parseClassificationResponse(response.content);

      // Only accept classifications that match an actual input finding.
      const seen = new Set<string>();
      for (const cls of parsed) {
        const key = `${cls.location}|${cls.findingType}`;
        if (seen.has(key) || !validKeys.has(key)) continue;
        seen.add(key);
        allClassifications.push(cls);
      }
    } catch {
      // Provider failure for one file must not abort other files.
      // The findings for this file just won't have AI classifications.
      continue;
    }
  }

  return {
    classifiedAt: new Date().toISOString(),
    provider: provider.name,
    model: provider.model,
    classifications: allClassifications,
  };
}
