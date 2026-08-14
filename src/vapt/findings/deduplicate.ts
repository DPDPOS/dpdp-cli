import type { VaptFinding } from "./types.js";

/**
 * Deduplicate VAPT findings within a single scan.
 *
 * Key (Phase 3 design §6): `target-identity | checkId | endpoint`. Distinct
 * targets never collapse into each other (hostname/IP is part of the key).
 * First occurrence wins and order is preserved, matching Phase 1
 * deduplication semantics.
 */
export function deduplicateFindings(findings: VaptFinding[]): VaptFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const host = finding.target.hostname ?? finding.target.ip ?? finding.target.url ?? "";
    const key = `${host}|${finding.checkId}|${finding.target.endpoint ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
