import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceBundle,
  type Finding,
} from "./types.js";

describe("evidence schema", () => {
  test("Finding keeps the exact backend contract fields", () => {
    const finding: Finding = {
      sourceType: "CODE",
      location: "src/a.ts:1",
      findingType: "consent_reference",
      excerpt: "// consent",
      confidence: 0.85,
      controlCandidates: ["DPDP-CONSENT-COLLECT"],
      sourceHash: "abc123",
    };
    assert.deepEqual(Object.keys(finding).sort(), [
      "confidence",
      "controlCandidates",
      "excerpt",
      "findingType",
      "location",
      "sourceHash",
      "sourceType",
    ]);
  });

  test("optional fields are optional", () => {
    const finding: Finding = {
      sourceType: "CONFIG",
      location: "config.json:1",
      findingType: "retention_config",
      confidence: 0.85,
      controlCandidates: [],
    };
    assert.equal(finding.excerpt, undefined);
    assert.equal(finding.sourceHash, undefined);
  });

  test("EvidenceBundle carries schemaVersion without changing Finding shape", () => {
    const bundle: EvidenceBundle = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      findings: [],
    };
    assert.equal(bundle.schemaVersion, 1);
    assert.equal(EVIDENCE_SCHEMA_VERSION, 1);

    // Findings themselves must NOT gain fields (backend payload contract).
    const finding: Finding = {
      sourceType: "DOCUMENT",
      location: "docs/p.md:1",
      findingType: "notice_language",
      confidence: 0.85,
      controlCandidates: [],
    };
    assert.equal("schemaVersion" in finding, false);
  });
});
