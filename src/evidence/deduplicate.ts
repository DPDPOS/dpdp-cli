import type { Finding } from "./types.js";

/**
 * Deduplicate findings by `location + findingType`.
 *
 * Semantics preserved exactly from the original scanner (Phase 1
 * constraint: deduplication behavior must not change). First occurrence
 * wins and order is preserved.
 */
export function deduplicate(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.location}|${finding.findingType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
