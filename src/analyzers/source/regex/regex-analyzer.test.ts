import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ScanContext } from "../../../core/scanner/scan-context.js";
import type { SourceKind } from "../../../evidence/types.js";
import { PATTERNS } from "./patterns.js";
import { RegexAnalyzer } from "./regex-analyzer.js";

function ctx(kind: SourceKind, content: string, relativePath = "src/a.ts"): ScanContext {
  return Object.freeze({
    targetPath: "/tmp/target",
    absolutePath: `/tmp/target/${relativePath}`,
    relativePath,
    kind,
    content,
    sourceHash: "a".repeat(64),
    sizeBytes: Buffer.byteLength(content),
  });
}

describe("RegexAnalyzer", () => {
  test("produces findings with preserved location/excerpt/confidence/controls", () => {
    const analyzer = new RegexAnalyzer();
    const out = analyzer.analyze(
      ctx("CODE", "export function withdrawConsent() {\n  // consent withdrawal handler\n"),
    );
    assert.deepEqual(
      out.map((f) => [f.location, f.findingType]),
      [
        ["src/a.ts:1", "consent_reference"],
        ["src/a.ts:1", "consent_withdrawal"],
        ["src/a.ts:2", "consent_reference"],
        ["src/a.ts:2", "consent_withdrawal"],
      ],
    );
    assert.equal(out[0]?.confidence, 0.85);
    assert.deepEqual(out[0]?.controlCandidates, [
      "DPDP-CONSENT-COLLECT",
      "DPDP-CONSENT-NOTICE",
    ]);
    assert.equal(out[0]?.excerpt, "export function withdrawConsent() {");
    assert.equal(out[0]?.location, "src/a.ts:1");
  });

  test("location uses relative/path:line format", () => {
    const out = new RegexAnalyzer().analyze(
      ctx("CODE", "line1\nconsent\nline3", "nested/deep/file.ts"),
    );
    assert.deepEqual(
      out.map((f) => f.location),
      ["nested/deep/file.ts:2"],
    );
  });

  test("excerpt is trimmed and capped at 300 chars", () => {
    const longLine = `consent ${"x".repeat(500)}`;
    const out = new RegexAnalyzer().analyze(ctx("CODE", longLine));
    assert.equal(out[0]?.excerpt?.length, 300);
    assert.equal(out[0]?.excerpt, longLine.trim().slice(0, 300));
  });

  test("handles CRLF line endings", () => {
    const out = new RegexAnalyzer().analyze(ctx("CODE", "first\r\nconsent\r\n"));
    assert.deepEqual(
      out.map((f) => f.location),
      ["src/a.ts:2"],
    );
  });

  test("produces no findings when nothing matches", () => {
    assert.deepEqual(new RegexAnalyzer().analyze(ctx("CODE", "nothing here")), []);
  });
});

describe("pattern applicability", () => {
  const content = "We collect personal data with consent. Privacy notice presented. LOG_RETENTION_DAYS=365";

  test("CODE rules fire only on CODE files", () => {
    const kinds = new RegexAnalyzer().analyze(ctx("CODE", content));
    assert.deepEqual(
      kinds.map((f) => f.findingType),
      ["consent_reference", "retention_reference"],
    );
  });

  test("DOCUMENT rules fire only on DOCUMENT files", () => {
    const kinds = new RegexAnalyzer().analyze(ctx("DOCUMENT", content));
    assert.deepEqual(
      kinds.map((f) => f.findingType),
      ["notice_language"],
    );
  });

  test("CONFIG rules fire only on CONFIG files", () => {
    const kinds = new RegexAnalyzer().analyze(ctx("CONFIG", content));
    assert.deepEqual(
      kinds.map((f) => f.findingType),
      ["retention_config"],
    );
  });

  test("no cross-kind matching: DOCUMENT rules do not fire on CODE", () => {
    const out = new RegexAnalyzer().analyze(
      ctx("CODE", "Privacy notice. Processors require a DPA."),
    );
    assert.deepEqual(out, []);
  });

  test("every rule declares explicit applicableKinds (no implicit matrix)", () => {
    for (const pattern of PATTERNS) {
      assert.ok(pattern.applicableKinds.length > 0, pattern.findingType);
      for (const kind of pattern.applicableKinds) {
        assert.ok(["CODE", "CONFIG", "DOCUMENT"].includes(kind), pattern.findingType);
      }
    }
  });
});
