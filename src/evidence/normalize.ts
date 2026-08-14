import type { ScanContext } from "../core/scanner/scan-context.js";
import type { Finding, RawFinding } from "./types.js";

/**
 * Normalize raw analyzer output into a `Finding` by stamping
 * context-derived fields (sourceType, sourceHash). Raw analyzer output
 * stays free of context concerns; this stage owns the Finding contract.
 */
export function normalizeFinding(raw: RawFinding, context: ScanContext): Finding {
  return {
    sourceType: context.kind,
    location: raw.location,
    findingType: raw.findingType,
    excerpt: raw.excerpt,
    confidence: raw.confidence,
    controlCandidates: raw.controlCandidates,
    sourceHash: context.sourceHash,
  };
}
