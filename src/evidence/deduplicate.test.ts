import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deduplicate } from "./deduplicate.js";
import type { Finding } from "./types.js";

function finding(location: string, findingType: string): Finding {
  return {
    sourceType: "CODE",
    location,
    findingType,
    confidence: 0.85,
    controlCandidates: [],
  };
}

describe("deduplicate", () => {
  test("removes duplicates keyed by location+findingType", () => {
    const input = [
      finding("a.ts:1", "consent_reference"),
      finding("a.ts:1", "consent_reference"),
      finding("a.ts:2", "consent_reference"),
      finding("a.ts:1", "deletion_endpoint"),
    ];
    assert.deepEqual(deduplicate(input), [input[0], input[2], input[3]]);
  });

  test("keeps the first occurrence and preserves order", () => {
    const first = finding("a.ts:1", "consent_reference");
    const input = [first, finding("a.ts:1", "consent_reference"), first];
    const out = deduplicate(input);
    assert.equal(out.length, 1);
    assert.equal(out[0], first);
  });

  test("does not collapse distinct locations or findingTypes", () => {
    const input = [
      finding("a.ts:1", "consent_reference"),
      finding("b.ts:1", "consent_reference"),
      finding("a.ts:1", "breach_reference"),
    ];
    assert.deepEqual(deduplicate(input), input);
  });

  test("handles empty input", () => {
    assert.deepEqual(deduplicate([]), []);
  });
});
