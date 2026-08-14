import { randomUUID } from "node:crypto";
import type { VaptCheck } from "../checks/types.js";
import { normalizeSeverity } from "./severity.js";
import type { EvidenceItem, RawVaptFinding, VaptFinding } from "./types.js";

export type NormalizedFinding = {
  finding: VaptFinding;
  evidence: EvidenceItem[];
};

/**
 * Normalize raw check output into a `VaptFinding` by stamping identity
 * (findingId), evidence ids, timestamps and provenance. Raw output stays
 * free of these concerns; this stage owns the VAPT finding contract.
 */
export function normalizeFinding(
  raw: RawVaptFinding,
  check: VaptCheck,
  observedAt: string,
  scannerVersion: string,
): NormalizedFinding {
  const evidence: EvidenceItem[] = raw.evidence.map((draft) => ({
    ...draft,
    evidenceId: `ev-${randomUUID()}`,
    capturedAt: observedAt,
  }));
  const { severity, unmapped } = normalizeSeverity(raw.severity, check.defaultSeverity);
  const finding: VaptFinding = {
    findingId: `finding-${randomUUID()}`,
    checkId: check.checkId,
    category: check.category,
    severity,
    title: raw.title,
    findingCode: raw.findingCode,
    target: raw.target,
    description: unmapped
      ? `${raw.description} [severity unclassified; defaulted to ${severity}]`
      : raw.description,
    impact: raw.impact,
    evidenceRefs: evidence.map((item) => item.evidenceId),
    observedAt,
    recommendation: raw.recommendation,
    remediationPriority: raw.remediationPriority,
    references: raw.references,
    provenance: {
      scanner: "dpdp-cli",
      scannerVersion,
      checkId: check.checkId,
      checkVersion: check.version,
      source: "local-check",
    },
  };
  for (const item of evidence) item.findingId = finding.findingId;
  return { finding, evidence };
}
