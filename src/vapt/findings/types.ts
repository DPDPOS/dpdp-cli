/**
 * VAPT finding + evidence model (Phase 3 design,
 * `docs/vapt/03-finding-evidence-model.md`). Deliberately separate from the
 * DPDP `Finding` (src/evidence/types.ts): different fields, different
 * schema version, different dedup key.
 */
import type { VaptTargetType } from "../scope/types.js";

export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export const SEVERITIES: readonly Severity[] = [
  "INFO",
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
];

export type RemediationPriority = "immediate" | "scheduled" | "informational";

export type VaptFindingTarget = {
  targetType: VaptTargetType;
  hostname?: string;
  ip?: string;
  url?: string;
  port?: number;
  protocol?: string;
  endpoint?: string;
};

export type VaptProvenance = {
  scanner: string;
  scannerVersion: string;
  checkId: string;
  checkVersion: string;
  source: "local-check" | "external-tool-import";
};

export type VaptFinding = {
  findingId: string;
  checkId: string;
  category: string;
  severity: Severity;
  title: string;
  findingCode?: string;
  target: VaptFindingTarget;
  description: string;
  impact?: string;
  /** References to evidence items produced by the same check run. */
  evidenceRefs: string[];
  artifactRefs?: string[];
  observedAt: string;
  recommendation?: string;
  remediationPriority?: RemediationPriority;
  references?: {
    standards?: string[];
    advisories?: string[];
    cwes?: string[];
    cves?: string[];
  };
  provenance: VaptProvenance;
};

export type TlsEvidence = {
  version?: string;
  cipherSuite?: string;
  certificate?: {
    subject?: string;
    issuer?: string;
    validFrom?: string;
    validTo?: string;
    selfSigned?: boolean;
  };
};

export type EvidenceItem = {
  evidenceId: string;
  /** Back-reference, stamped by the engine after normalization. */
  findingId?: string;
  kind: "observation" | "http" | "tls" | "config" | "service";
  observedValue?: string;
  /** Only when kind === "http". Header values are sanitized (allowlist). */
  http?: {
    method: string;
    url: string;
    status: number;
    headers: { name: string; value: string }[];
  };
  tls?: TlsEvidence;
  config?: { source: string; key?: string; value?: string };
  hashes?: Record<string, string>;
  capturedAt: string;
};

/**
 * Raw finding produced by a check before the engine stamps identity,
 * provenance, evidence ids and timestamps.
 */
export type RawVaptFinding = Omit<
  VaptFinding,
  "findingId" | "evidenceRefs" | "artifactRefs" | "provenance" | "observedAt"
> & {
  evidence: EvidenceItemDraft[];
};

/** Evidence as produced by a check, before ids/timestamps are stamped. */
export type EvidenceItemDraft = Omit<EvidenceItem, "evidenceId" | "findingId" | "capturedAt">;

/**
 * VAPT evidence artifact schema version. Distinct from the DPDP evidence
 * schema (EVIDENCE_SCHEMA_VERSION = 1) — the two families are versioned
 * separately per Phase 3 design.
 */
export const VAPT_EVIDENCE_SCHEMA_VERSION = 2 as const;

/** Locally stored VAPT evidence envelope (written via EvidenceStore). */
export type VaptEvidenceBundle = {
  scanId: string;
  capability: "VAPT";
  schemaVersion: typeof VAPT_EVIDENCE_SCHEMA_VERSION;
  vaptFindings: VaptFinding[];
  evidence: EvidenceItem[];
};
