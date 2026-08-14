import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeSeverity, maxSeverity } from "./severity.js";
import { normalizeFinding } from "./normalize.js";
import { deduplicateFindings } from "./deduplicate.js";
import type { RawVaptFinding, VaptFinding } from "./types.js";

const CHECK = {
  checkId: "test/check",
  name: "Test check",
  category: "test",
  description: "x",
  supportedTargetTypes: ["URL", "HOSTNAME", "IP"] as const,
  defaultSeverity: "LOW" as const,
  version: "1.2.3",
  executionRequirements: { passiveOnly: true, safeOnly: true },
  run: async () => ({ findings: [] }),
};

function raw(overrides: Partial<RawVaptFinding> = {}): RawVaptFinding {
  return {
    checkId: "test/check",
    category: "test",
    severity: "MEDIUM",
    title: "Title",
    target: { targetType: "URL", hostname: "app.example.com" },
    description: "Description",
    evidence: [{ kind: "observation", observedValue: "v" }],
    ...overrides,
  };
}

describe("normalizeSeverity", () => {
  test("valid severities pass through", () => {
    for (const s of ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const) {
      assert.deepEqual(normalizeSeverity(s, "MEDIUM"), { severity: s, unmapped: false });
    }
  });
  test("unmapped values fall back without upgrading", () => {
    assert.deepEqual(normalizeSeverity("critical!!!", "MEDIUM"), {
      severity: "MEDIUM",
      unmapped: true,
    });
  });
  test("maxSeverity picks the more severe", () => {
    assert.equal(maxSeverity("INFO", "HIGH"), "HIGH");
    assert.equal(maxSeverity("CRITICAL", "HIGH"), "CRITICAL");
    assert.equal(maxSeverity("MEDIUM", "LOW"), "MEDIUM");
  });
});

describe("normalizeFinding", () => {
  test("stamps identity, provenance, evidence ids and timestamps", () => {
    const { finding, evidence } = normalizeFinding(raw(), CHECK, "2026-01-01T00:00:00.000Z", "0.1.0");
    assert.match(finding.findingId, /^finding-/);
    assert.equal(finding.checkId, "test/check");
    assert.equal(finding.category, "test");
    assert.equal(finding.severity, "MEDIUM");
    assert.equal(finding.observedAt, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(finding.provenance, {
      scanner: "dpdp-cli",
      scannerVersion: "0.1.0",
      checkId: "test/check",
      checkVersion: "1.2.3",
      source: "local-check",
    });
    assert.equal(finding.evidenceRefs.length, 1);
    assert.equal(evidence.length, 1);
    assert.match(evidence[0]!.evidenceId, /^ev-/);
    assert.equal(evidence[0]!.findingId, finding.findingId);
    assert.equal(evidence[0]!.capturedAt, "2026-01-01T00:00:00.000Z");
  });

  test("unmapped severity falls back to the check default and is noted", () => {
    const { finding } = normalizeFinding(raw({ severity: "bogus" as never }), CHECK, "t", "0.1.0");
    assert.equal(finding.severity, "LOW");
    assert.match(finding.description, /defaulted to LOW/);
  });
});

describe("deduplicateFindings", () => {
  function finding(overrides: Partial<VaptFinding>): VaptFinding {
    return {
      findingId: "finding-1",
      checkId: "tls/check",
      category: "tls",
      severity: "LOW",
      title: "t",
      target: { targetType: "URL", hostname: "app.example.com" },
      description: "d",
      evidenceRefs: [],
      observedAt: "t",
      provenance: {
        scanner: "dpdp-cli",
        scannerVersion: "0.1.0",
        checkId: "tls/check",
        checkVersion: "1.0.0",
        source: "local-check",
      },
      ...overrides,
    };
  }

  test("same host + checkId + endpoint dedupes (first wins)", () => {
    const a = finding({ findingId: "a", description: "first" });
    const b = finding({ findingId: "b", description: "second" });
    const out = deduplicateFindings([a, b]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.findingId, "a");
  });

  test("different hosts are never collapsed", () => {
    const a = finding({ findingId: "a", target: { targetType: "URL", hostname: "a.example.com" } });
    const b = finding({ findingId: "b", target: { targetType: "URL", hostname: "b.example.com" } });
    assert.equal(deduplicateFindings([a, b]).length, 2);
  });

  test("different endpoints are kept", () => {
    const a = finding({ findingId: "a", target: { targetType: "URL", hostname: "h", endpoint: "/a" } });
    const b = finding({ findingId: "b", target: { targetType: "URL", hostname: "h", endpoint: "/b" } });
    assert.equal(deduplicateFindings([a, b]).length, 2);
  });
});
