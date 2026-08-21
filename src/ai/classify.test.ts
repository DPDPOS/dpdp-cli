import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import type { Finding } from "../evidence/types.js";
import type { AiProvider } from "./classify.js";
import {
  classifyFindings,
  createOpenAiCompatibleProvider,
  createProviderFromEnv,
  extractContext,
  parseClassificationResponse,
  parseLocation,
} from "./classify.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function finding(
  overrides: Partial<Finding> & { location: string; findingType: string },
): Finding {
  return {
    sourceType: "CODE",
    excerpt: "// consent",
    confidence: 0.85,
    controlCandidates: ["DPDP-CONSENT-COLLECT"],
    ...overrides,
  };
}

function mockProvider(response: string): AiProvider {
  return {
    name: "mock",
    model: "mock-model",
    async complete() {
      return { content: response };
    },
  };
}

function failingProvider(errorMsg: string): AiProvider {
  return {
    name: "mock-fail",
    model: "mock-model",
    async complete() {
      throw new Error(errorMsg);
    },
  };
}

async function makeFixture(
  t: { after: (fn: () => unknown) => void },
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpdp-ai-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  const code = [
    "export function withdrawConsent() {",
    "  // consent withdrawal handler",
    "  return true;",
    "}",
    "",
    "export function eraseUserAccount() {",
    "  // rights erasure",
    "  router.delete('/account', eraseUser);",
    "}",
  ].join("\n");
  await fs.writeFile(path.join(dir, "src", "privacy.ts"), code);
  return dir;
}

// ---------------------------------------------------------------------------
// 1. parseLocation
// ---------------------------------------------------------------------------

describe("parseLocation", () => {
  test("parses valid location", () => {
    const r = parseLocation("src/privacy.ts:3");
    assert.deepEqual(r, { relativePath: "src/privacy.ts", line: 3 });
  });

  test("handles path with colons in directory name", () => {
    const r = parseLocation("a:b/file.ts:10");
    assert.deepEqual(r, { relativePath: "a:b/file.ts", line: 10 });
  });

  test("returns null for missing line number", () => {
    assert.equal(parseLocation("src/file.ts"), null);
  });

  test("returns null for non-numeric line", () => {
    assert.equal(parseLocation("src/file.ts:abc"), null);
  });

  test("returns null for zero line", () => {
    assert.equal(parseLocation("src/file.ts:0"), null);
  });
});

// ---------------------------------------------------------------------------
// 2. extractContext
// ---------------------------------------------------------------------------

describe("extractContext", () => {
  const lines = ["line1", "line2", "line3", "line4", "line5"];

  test("extracts context around middle line", () => {
    const ctx = extractContext(lines, 3, 2);
    assert.deepEqual(ctx, ["line1", "line2", "line3", "line4", "line5"]);
  });

  test("context at first line", () => {
    const ctx = extractContext(lines, 1, 3);
    assert.deepEqual(ctx, ["line1", "line2", "line3", "line4"]);
  });

  test("context at last line", () => {
    const ctx = extractContext(lines, 5, 3);
    assert.deepEqual(ctx, ["line2", "line3", "line4", "line5"]);
  });

  test("single line file", () => {
    const ctx = extractContext(["only"], 1, 3);
    assert.deepEqual(ctx, ["only"]);
  });

  test("contextLines=0 returns only the matching line", () => {
    const ctx = extractContext(lines, 3, 0);
    assert.deepEqual(ctx, ["line3"]);
  });
});

// ---------------------------------------------------------------------------
// 3. parseClassificationResponse
// ---------------------------------------------------------------------------

describe("parseClassificationResponse", () => {
  test("parses clean JSON array", () => {
    const input = JSON.stringify([
      {
        location: "src/a.ts:1",
        findingType: "consent_reference",
        classification: "positive_evidence",
        reasoning: "Implements consent",
        confidence: 0.9,
      },
    ]);
    const result = parseClassificationResponse(input);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.classification, "positive_evidence");
    assert.equal(result[0]?.confidence, 0.9);
  });

  test("strips markdown code fences", () => {
    const input = '```json\n[{"location":"a.ts:1","findingType":"x","classification":"reference_only","reasoning":"ref","confidence":0.7}]\n```';
    const result = parseClassificationResponse(input);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.classification, "reference_only");
  });

  test("handles text before/after JSON array", () => {
    const input = 'Here are the classifications:\n[{"location":"a.ts:1","findingType":"x","classification":"negative_evidence","reasoning":"neg","confidence":0.8}]\nDone.';
    const result = parseClassificationResponse(input);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.classification, "negative_evidence");
  });

  test("returns empty array for malformed JSON", () => {
    assert.deepEqual(parseClassificationResponse("not json at all"), []);
  });

  test("returns empty array for empty array", () => {
    assert.deepEqual(parseClassificationResponse("[]"), []);
  });

  test("skips items with invalid classification values", () => {
    const input = JSON.stringify([
      { location: "a.ts:1", findingType: "x", classification: "invalid", reasoning: "bad", confidence: 0.5 },
      { location: "a.ts:2", findingType: "y", classification: "positive_evidence", reasoning: "good", confidence: 0.9 },
    ]);
    const result = parseClassificationResponse(input);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.location, "a.ts:2");
  });

  test("defaults confidence to 0.5 when missing or out of range", () => {
    const input = JSON.stringify([
      { location: "a.ts:1", findingType: "x", classification: "positive_evidence", reasoning: "r" },
      { location: "a.ts:2", findingType: "y", classification: "reference_only", reasoning: "r", confidence: 2.0 },
    ]);
    const result = parseClassificationResponse(input);
    assert.equal(result[0]?.confidence, 0.5);
    assert.equal(result[1]?.confidence, 0.5);
  });

  test("handles non-object items in array", () => {
    const input = JSON.stringify([
      "not an object",
      null,
      42,
      { location: "a.ts:1", findingType: "x", classification: "positive_evidence", reasoning: "ok", confidence: 0.8 },
    ]);
    const result = parseClassificationResponse(input);
    assert.equal(result.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 4. classifyFindings — valid output
// ---------------------------------------------------------------------------

describe("classifyFindings", () => {
  test("classifies findings and returns ClassificationResult", async (t) => {
    const dir = await makeFixture(t);
    const findings = [
      finding({ location: "src/privacy.ts:3", findingType: "consent_reference" }),
      finding({ location: "src/privacy.ts:8", findingType: "erasure_logic" }),
    ];

    const provider = mockProvider(
      JSON.stringify([
        {
          location: "src/privacy.ts:3",
          findingType: "consent_reference",
          classification: "reference_only",
          reasoning: "Comment mentions consent, not implementation",
          confidence: 0.85,
        },
        {
          location: "src/privacy.ts:8",
          findingType: "erasure_logic",
          classification: "positive_evidence",
          reasoning: "eraseUserAccount function implements erasure",
          confidence: 0.92,
        },
      ]),
    );

    const result = await classifyFindings(
      { findings, targetPath: dir },
      provider,
    );

    assert.equal(result.provider, "mock");
    assert.equal(result.model, "mock-model");
    assert.ok(result.classifiedAt);
    assert.equal(result.classifications.length, 2);

    const c1 = result.classifications.find(
      (c) => c.location === "src/privacy.ts:3",
    );
    assert.equal(c1?.classification, "reference_only");
    assert.equal(c1?.reasoning, "Comment mentions consent, not implementation");

    const c2 = result.classifications.find(
      (c) => c.location === "src/privacy.ts:8",
    );
    assert.equal(c2?.classification, "positive_evidence");
  });

  // ---------------------------------------------------------------------------
  // 5. malformed AI response
  // ---------------------------------------------------------------------------

  test("handles malformed AI response gracefully", async (t) => {
    const dir = await makeFixture(t);
    const findings = [
      finding({ location: "src/privacy.ts:3", findingType: "consent_reference" }),
    ];

    const provider = mockProvider("Sorry, I cannot classify this.");

    const result = await classifyFindings(
      { findings, targetPath: dir },
      provider,
    );

    assert.equal(result.classifications.length, 0);
    assert.equal(result.provider, "mock");
  });

  // ---------------------------------------------------------------------------
  // 6. provider failure
  // ---------------------------------------------------------------------------

  test("provider failure returns empty classifications, does not throw", async (t) => {
    const dir = await makeFixture(t);
    const findings = [
      finding({ location: "src/privacy.ts:3", findingType: "consent_reference" }),
    ];

    const provider = failingProvider("network timeout");

    const result = await classifyFindings(
      { findings, targetPath: dir },
      provider,
    );

    assert.equal(result.classifications.length, 0);
    assert.equal(result.classifiedAt.length > 0, true);
  });

  // ---------------------------------------------------------------------------
  // 7. CONFIG files are skipped
  // ---------------------------------------------------------------------------

  test("skips CONFIG findings entirely", async (t) => {
    const dir = await makeFixture(t);
    // Write a config file
    await fs.writeFile(
      path.join(dir, ".env.example"),
      "LOG_RETENTION_DAYS=365\n",
    );

    const findings = [
      finding({
        sourceType: "CONFIG",
        location: ".env.example:1",
        findingType: "retention_config",
      }),
    ];

    let called = false;
    const provider: AiProvider = {
      name: "mock",
      model: "mock-model",
      async complete() {
        called = true;
        return { content: "[]" };
      },
    };

    const result = await classifyFindings(
      { findings, targetPath: dir },
      provider,
    );

    assert.equal(called, false, "provider must not be called for CONFIG files");
    assert.equal(result.classifications.length, 0);
  });

  // ---------------------------------------------------------------------------
  // 8. context extraction at first line
  // ---------------------------------------------------------------------------

  test("context extraction works at file line 1", async (t) => {
    const dir = await makeFixture(t);
    const findings = [
      finding({ location: "src/privacy.ts:1", findingType: "consent_reference" }),
    ];

    let capturedPrompt = "";
    const provider: AiProvider = {
      name: "mock",
      model: "mock-model",
      async complete(req) {
        capturedPrompt = req.prompt;
        return { content: "[]" };
      },
    };

    await classifyFindings({ findings, targetPath: dir }, provider);

    assert.ok(
      capturedPrompt.includes("export function withdrawConsent"),
      "prompt should include first line of file",
    );
  });

  // ---------------------------------------------------------------------------
  // 9. context extraction at last line
  // ---------------------------------------------------------------------------

  test("context extraction works at last line", async (t) => {
    const dir = await makeFixture(t);
    const findings = [
      finding({
        location: "src/privacy.ts:9",
        findingType: "erasure_logic",
      }),
    ];

    let capturedPrompt = "";
    const provider: AiProvider = {
      name: "mock",
      model: "mock-model",
      async complete(req) {
        capturedPrompt = req.prompt;
        return { content: "[]" };
      },
    };

    await classifyFindings({ findings, targetPath: dir }, provider);

    // Line 9 is "}" — the last line of the 9-line file
    assert.ok(capturedPrompt.includes("}"), "prompt should include last line");
  });

  // ---------------------------------------------------------------------------
  // 10. provider receives batched prompt, not one per finding
  // ---------------------------------------------------------------------------

  test("batches multiple findings from same file into one provider call", async (t) => {
    const dir = await makeFixture(t);
    const findings = [
      finding({ location: "src/privacy.ts:3", findingType: "consent_reference" }),
      finding({ location: "src/privacy.ts:8", findingType: "erasure_logic" }),
    ];

    let callCount = 0;
    const provider: AiProvider = {
      name: "mock",
      model: "mock-model",
      async complete() {
        callCount++;
        return { content: "[]" };
      },
    };

    await classifyFindings({ findings, targetPath: dir }, provider);

    assert.equal(callCount, 1, "should batch into one call for same file");
  });

  // ---------------------------------------------------------------------------
  // 11. provider failure on one file doesn't affect others
  // ---------------------------------------------------------------------------

  test("provider failure on one file does not affect other files", async (t) => {
    const dir = await makeFixture(t);
    // Create a second file
    await fs.writeFile(
      path.join(dir, "src", "other.ts"),
      "export function doErasure() {\n  // erasure\n}\n",
    );

    const findings = [
      finding({ location: "src/privacy.ts:3", findingType: "consent_reference" }),
      finding({ location: "src/other.ts:2", findingType: "erasure_logic" }),
    ];

    let callCount = 0;
    const provider: AiProvider = {
      name: "mock",
      model: "mock-model",
      async complete(req) {
        callCount++;
        // Fail on the first file, succeed on the second
        if (req.prompt.includes("privacy.ts")) {
          throw new Error("API down");
        }
        return {
          content: JSON.stringify([
            {
              location: "src/other.ts:2",
              findingType: "erasure_logic",
              classification: "positive_evidence",
              reasoning: "Erasure function",
              confidence: 0.9,
            },
          ]),
        };
      },
    };

    const result = await classifyFindings({ findings, targetPath: dir }, provider);

    assert.equal(callCount, 2, "provider called for both files");
    assert.equal(result.classifications.length, 1);
    assert.equal(result.classifications[0]?.location, "src/other.ts:2");
  });

  // ---------------------------------------------------------------------------
  // 12. empty findings list
  // ---------------------------------------------------------------------------

  test("empty findings list returns empty classifications", async (t) => {
    const dir = await makeFixture(t);
    let called = false;
    const provider: AiProvider = {
      name: "mock",
      model: "mock-model",
      async complete() {
        called = true;
        return { content: "[]" };
      },
    };

    const result = await classifyFindings(
      { findings: [], targetPath: dir },
      provider,
    );

    assert.equal(called, false, "provider should not be called for empty findings");
    assert.equal(result.classifications.length, 0);
  });

  // ---------------------------------------------------------------------------
  // 13. fabricated locations are rejected
  // ---------------------------------------------------------------------------

  test("rejects classifications for locations not in input findings", async (t) => {
    const dir = await makeFixture(t);
    const findings = [
      finding({ location: "src/privacy.ts:3", findingType: "consent_reference" }),
    ];

    const provider = mockProvider(
      JSON.stringify([
        {
          location: "src/privacy.ts:3",
          findingType: "consent_reference",
          classification: "positive_evidence",
          reasoning: "real",
          confidence: 0.9,
        },
        {
          location: "../../etc/passwd:1",
          findingType: "consent_reference",
          classification: "positive_evidence",
          reasoning: "fabricated",
          confidence: 0.9,
        },
        {
          location: "src/privacy.ts:99",
          findingType: "nonexistent_type",
          classification: "reference_only",
          reasoning: "fabricated",
          confidence: 0.8,
        },
      ]),
    );

    const result = await classifyFindings(
      { findings, targetPath: dir },
      provider,
    );

    // Only the real finding's classification should be accepted.
    assert.equal(result.classifications.length, 1);
    assert.equal(result.classifications[0]?.location, "src/privacy.ts:3");
    assert.equal(result.classifications[0]?.classification, "positive_evidence");
  });

  test("rejects classification with wrong findingType for a real location", async (t) => {
    const dir = await makeFixture(t);
    const findings = [
      finding({ location: "src/privacy.ts:3", findingType: "consent_reference" }),
    ];

    const provider = mockProvider(
      JSON.stringify([
        {
          location: "src/privacy.ts:3",
          findingType: "erasure_logic",
          classification: "positive_evidence",
          reasoning: "wrong type",
          confidence: 0.9,
        },
      ]),
    );

    const result = await classifyFindings(
      { findings, targetPath: dir },
      provider,
    );

    assert.equal(result.classifications.length, 0);
  });

  // ---------------------------------------------------------------------------
  // 14. AI failure does not interrupt normal evidence submission
  // ---------------------------------------------------------------------------

  test("AI failure does not prevent evidence submission", async (t) => {
    const dir = await makeFixture(t);
    const findings = [
      finding({ location: "src/privacy.ts:3", findingType: "consent_reference" }),
    ];

    const provider = failingProvider("network error");

    // classifyFindings should return empty classifications, not throw
    const result = await classifyFindings(
      { findings, targetPath: dir },
      provider,
    );

    assert.equal(result.classifications.length, 0);
    assert.ok(result.classifiedAt, "should still have a timestamp");
    assert.equal(result.provider, "mock-fail");
  });
});

// ---------------------------------------------------------------------------
// 15. createProviderFromEnv — Groq configuration
// ---------------------------------------------------------------------------

describe("createProviderFromEnv", () => {
  const originalEnv = { ...process.env };

  function restoreEnv() {
    process.env = { ...originalEnv };
  }

  test("returns null when GROQ_API_KEY is not set", () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_BASE_URL;
    delete process.env.GROQ_MODEL;
    const provider = createProviderFromEnv();
    assert.equal(provider, null);
  });

  test("creates provider when GROQ_API_KEY is set", () => {
    process.env.GROQ_API_KEY = "test-key";
    process.env.GROQ_BASE_URL = "https://custom.groq.example/v1";
    process.env.GROQ_MODEL = "custom-model";
    const provider = createProviderFromEnv();
    assert.ok(provider, "should create provider");
    assert.equal(provider!.name, "groq");
    assert.equal(provider!.model, "custom-model");
    restoreEnv();
  });

  test("uses default base URL when GROQ_BASE_URL is not set", () => {
    process.env.GROQ_API_KEY = "test-key";
    delete process.env.GROQ_BASE_URL;
    delete process.env.GROQ_MODEL;
    const provider = createProviderFromEnv();
    assert.ok(provider);
    assert.equal(provider!.model, "allam-2-7b");
    restoreEnv();
  });

  test("uses default model when GROQ_MODEL is not set", () => {
    process.env.GROQ_API_KEY = "test-key";
    delete process.env.GROQ_MODEL;
    const provider = createProviderFromEnv();
    assert.ok(provider);
    assert.equal(provider!.model, "allam-2-7b");
    restoreEnv();
  });

  test("OPENAI env vars are not used", () => {
    delete process.env.GROQ_API_KEY;
    process.env.OPENAI_API_KEY = "should-not-be-used";
    const provider = createProviderFromEnv();
    assert.equal(provider, null, "OPENAI_API_KEY should not create a provider");
    restoreEnv();
  });
});

// ---------------------------------------------------------------------------
// 16. createOpenAiCompatibleProvider — request construction
// ---------------------------------------------------------------------------

describe("createOpenAiCompatibleProvider", () => {
  test("sends request to correct Groq chat completions URL", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = typeof input === "string" ? input : String(input);
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "[]" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const provider = createOpenAiCompatibleProvider({
        apiKey: "test-key",
        baseUrl: "https://api.groq.com/openai/v1",
      });
      await provider.complete({ prompt: "test" });

      assert.equal(
        capturedUrl,
        "https://api.groq.com/openai/v1/chat/completions",
      );
      assert.equal(capturedBody.model, "allam-2-7b");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends Bearer token in Authorization header", async () => {
    let capturedHeaders: Record<string, string> = {};
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedHeaders = Object.fromEntries(
        new Headers(init?.headers).entries(),
      );
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "[]" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const provider = createOpenAiCompatibleProvider({
        apiKey: "sk-my-secret-key",
        baseUrl: "https://api.groq.com/openai/v1",
      });
      await provider.complete({ prompt: "test" });

      assert.equal(capturedHeaders.authorization, "Bearer sk-my-secret-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses custom model from options", async () => {
    let capturedBody: Record<string, unknown> = {};
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "[]" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const provider = createOpenAiCompatibleProvider({
        apiKey: "test-key",
        model: "mixtral-8x7b-32768",
      });
      await provider.complete({ prompt: "test" });

      assert.equal(capturedBody.model, "mixtral-8x7b-32768");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("defaults to Groq base URL when none provided", async () => {
    let capturedUrl = "";
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (
      input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = typeof input === "string" ? input : String(input);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "[]" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const provider = createOpenAiCompatibleProvider({ apiKey: "test-key" });
      await provider.complete({ prompt: "test" });

      assert.equal(
        capturedUrl,
        "https://api.groq.com/openai/v1/chat/completions",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("strips trailing slash from custom base URL", async () => {
    let capturedUrl = "";
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (
      input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = typeof input === "string" ? input : String(input);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "[]" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const provider = createOpenAiCompatibleProvider({
        apiKey: "test-key",
        baseUrl: "https://custom.api.example/v1/",
      });
      await provider.complete({ prompt: "test" });

      assert.equal(
        capturedUrl,
        "https://custom.api.example/v1/chat/completions",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("provider name is groq", () => {
    const provider = createOpenAiCompatibleProvider({ apiKey: "test-key" });
    assert.equal(provider.name, "groq");
  });

  test("default model is allam-2-7b", () => {
    const provider = createOpenAiCompatibleProvider({ apiKey: "test-key" });
    assert.equal(provider.model, "allam-2-7b");
  });

  test("throws on non-200 response", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (): Promise<Response> => {
      return new Response("rate limited", { status: 429 });
    };

    try {
      const provider = createOpenAiCompatibleProvider({ apiKey: "test-key" });
      await assert.rejects(
        () => provider.complete({ prompt: "test" }),
        /AI API returned 429/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("extracts content from chat completions response", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "classification result" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const provider = createOpenAiCompatibleProvider({ apiKey: "test-key" });
      const result = await provider.complete({ prompt: "test" });
      assert.equal(result.content, "classification result");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns empty string when response has no choices", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ choices: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const provider = createOpenAiCompatibleProvider({ apiKey: "test-key" });
      const result = await provider.complete({ prompt: "test" });
      assert.equal(result.content, "");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
