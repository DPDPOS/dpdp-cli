/**
 * Evidence model — the normalized representation of collected findings.
 *
 * `Finding` is the record stored locally (`~/.dpdp/config.json`) and
 * submitted to the DPDPOS backend. Its field names/shape are a backend
 * contract and must not change (Phase 1 constraint).
 */

export type SourceKind = "CODE" | "CONFIG" | "DOCUMENT";

export type Finding = {
  sourceType: SourceKind;
  /** Analyzer-produced location, format: relative/path:line */
  location: string;
  findingType: string;
  excerpt?: string;
  confidence: number;
  controlCandidates: string[];
  sourceHash?: string;
};

/**
 * Raw output produced by an Analyzer before the pipeline stamps
 * context-derived fields (sourceType, sourceHash).
 */
export type RawFinding = {
  findingType: string;
  location: string;
  excerpt?: string;
  confidence: number;
  controlCandidates: string[];
};

/**
 * Backward-compatible schema versioning.
 *
 * The version lives on the internal EvidenceBundle envelope only. It is
 * deliberately NOT added to individual `Finding` records: the findings
 * array is the backend payload, so adding a field there would change the
 * backend contract. `~/.dpdp/config.json` and the submitted payload keep
 * their exact prior shape.
 */
export const EVIDENCE_SCHEMA_VERSION = 1 as const;

export type EvidenceBundle = {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  findings: Finding[];
};
