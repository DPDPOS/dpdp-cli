import type { EvidenceItem, VaptFinding } from "../findings/types.js";
import type { VaptScanConfig } from "../profile/types.js";

/** Non-fatal problem encountered during a scan (never aborts the scan). */
export type VaptIssue = {
  code: string;
  message: string;
  checkId?: string;
};

export type VaptScanSummary = {
  checksExecuted: string[];
  checksSkipped: { checkId: string; reason: string }[];
  findings: VaptFinding[];
  evidence: EvidenceItem[];
  durationMs: number;
  issues: VaptIssue[];
};

/**
 * VAPT-specific execution state stored opaquely in the Phase 2 scan state
 * (`ScanState.extra`). The generic store does not know this shape; the vapt
 * module owns it.
 */
export type VaptScanStateExtra = {
  scopeVersion?: number;
  config?: VaptScanConfig;
  checks?: { executed: string[]; skipped: { checkId: string; reason: string }[] };
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  findingsCount?: number;
  error?: string;
};
