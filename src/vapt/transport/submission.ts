import type { AppConfig } from "../../storage/config-store.js";
import type { ScanState } from "../../storage/scan-state-store.js";
import type { EvidenceItem, VaptFinding } from "../findings/types.js";
import {
  VAPT_CHECK_CATALOG_VERSION,
  VAPT_CLI_VERSION,
  VAPT_ENGINE_VERSION,
  VAPT_SCANNER_NAME,
} from "../profile/default.js";
import type { VaptScanStateExtra } from "../engine/types.js";

/**
 * Typed internal payload representing what the future backend will receive
 * (Phase 3 design, `docs/vapt/06-backend-requirements.md`). The backend has
 * no VAPT API yet, so this builder is the transport boundary: local VAPT
 * execution is fully separated from backend submission. No request is made
 * anywhere in this module.
 */
export type VaptSubmissionPayload = {
  assessmentId: string;
  scanId: string;
  capability: "VAPT";
  target: {
    targetType: string;
    value: string;
  };
  scopeVersion: number;
  profile: string;
  mode: string;
  scanner: {
    name: string;
    version: string;
    engineVersion: string;
    checkCatalogVersion: string;
  };
  timestamps: {
    startedAt?: string;
    completedAt?: string;
    submittedAt: string;
  };
  findings: VaptFinding[];
  evidence: EvidenceItem[];
};

export function buildVaptSubmissionPayload(input: {
  config: AppConfig;
  state: ScanState;
  findings: VaptFinding[];
  evidence: EvidenceItem[];
}): VaptSubmissionPayload {
  const extra = (input.state.extra ?? {}) as VaptScanStateExtra;
  return {
    assessmentId: input.state.assessmentId,
    scanId: input.state.scanId,
    capability: "VAPT",
    target: {
      targetType: input.state.targetType ?? "URL",
      value: input.state.targetPath ?? "",
    },
    scopeVersion: extra.scopeVersion ?? 0,
    profile: extra.config?.profile ?? "",
    mode: extra.config?.mode ?? "passive",
    scanner: {
      name: VAPT_SCANNER_NAME,
      version: VAPT_CLI_VERSION,
      engineVersion: extra.config?.toolConfig?.engineVersion ?? VAPT_ENGINE_VERSION,
      checkCatalogVersion:
        extra.config?.toolConfig?.checkCatalogVersion ?? VAPT_CHECK_CATALOG_VERSION,
    },
    timestamps: {
      startedAt: extra.startedAt,
      completedAt: extra.completedAt,
      submittedAt: new Date().toISOString(),
    },
    findings: input.findings,
    evidence: input.evidence,
  };
}
