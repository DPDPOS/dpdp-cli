import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Minimal .env file parser and writer.
 *
 * - No external dependencies (no dotenv).
 * - Preserves existing variables, comments, and formatting.
 * - Only reads/writes GROQ_* variables; leaves everything else untouched.
 * - Sets file permissions to 0o600 on POSIX where supported.
 */

export type EnvVars = Record<string, string>;

const GROQ_KEYS = ["GROQ_API_KEY", "GROQ_BASE_URL", "GROQ_MODEL"] as const;

const GROQ_DEFAULTS: EnvVars = {
  GROQ_BASE_URL: "https://api.groq.com/openai/v1",
  GROQ_MODEL: "allam-2-7b",
};

/**
 * Parse a .env file into a map of key → value.
 * Handles: KEY=value, KEY="value", KEY='value', # comments, blank lines.
 * Lines without '=' are ignored.
 */
export function parseEnvFile(content: string): EnvVars {
  const result: EnvVars = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Serialize a map of env vars back to .env file content.
 * Only writes the given keys (does not reproduce comments or other lines).
 */
export function serializeEnvFile(vars: EnvVars): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    lines.push(`${key}=${value}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Read an existing .env file, or return null if it doesn't exist.
 */
export async function readEnvFile(filePath: string): Promise<EnvVars | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return parseEnvFile(content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write a .env file, preserving all existing non-GROQ lines.
 * Returns the final content written.
 */
export async function writeEnvFile(
  filePath: string,
  existingContent: string | null,
  updates: EnvVars,
): Promise<string> {
  const existingLines: string[] = existingContent
    ? existingContent.split(/\r?\n/)
    : [];

  // Build a map of existing lines by key for quick lookup
  const lineByKey = new Map<string, number>();
  for (let i = 0; i < existingLines.length; i++) {
    const line = existingLines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    lineByKey.set(key, i);
  }

  // Remove existing GROQ lines
  const filtered: string[] = [];
  for (let i = 0; i < existingLines.length; i++) {
    const line = existingLines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      filtered.push(line);
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      filtered.push(line);
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    if (GROQ_KEYS.includes(key as (typeof GROQ_KEYS)[number])) continue; // skip old GROQ lines
    filtered.push(line);
  }

  // Remove trailing blank lines before appending
  while (filtered.length > 0 && filtered[filtered.length - 1]?.trim() === "") {
    filtered.pop();
  }

  // Add a blank separator if there's existing content
  if (filtered.length > 0) {
    filtered.push("");
  }

  // Append new GROQ lines
  for (const key of GROQ_KEYS) {
    if (updates[key] !== undefined) {
      filtered.push(`${key}=${updates[key]}`);
    }
  }

  const content = filtered.join("\n") + "\n";

  // Write with restrictive permissions
  await fs.writeFile(filePath, content, { mode: 0o600 });
  return content;
}

/**
 * The only environment variable keys we ever load from .env files.
 * This is a strict allowlist — arbitrary keys from scanned projects
 * must never be injected into process.env.
 */
const LOADABLE_KEYS = new Set([
  "GROQ_API_KEY",
  "GROQ_BASE_URL",
  "GROQ_MODEL",
]);

/**
 * Load .env file into process.env, restricted to GROQ_* keys only.
 * - Only sets vars that are not already set in process.env.
 * - Ignores every key not in the allowlist.
 * - Returns true if the file existed and was parsed.
 */
export async function loadEnvFileIntoProcess(
  filePath: string,
): Promise<boolean> {
  const vars = await readEnvFile(filePath);
  if (vars === null) return false;
  for (const [key, value] of Object.entries(vars)) {
    if (!LOADABLE_KEYS.has(key)) continue;
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
  return true;
}

/**
 * Build the Groq env vars to write, using provided key and defaults.
 */
export function buildGroqEnvVars(apiKey: string): EnvVars {
  return {
    GROQ_API_KEY: apiKey,
    GROQ_BASE_URL: GROQ_DEFAULTS.GROQ_BASE_URL,
    GROQ_MODEL: GROQ_DEFAULTS.GROQ_MODEL,
  };
}

/**
 * Check whether .env has a GROQ_API_KEY.
 */
export function hasGroqKey(vars: EnvVars): boolean {
  const key = vars.GROQ_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

/**
 * Get the .env file path relative to the project root.
 */
export function envFilePath(projectRoot: string): string {
  return path.join(projectRoot, ".env");
}
