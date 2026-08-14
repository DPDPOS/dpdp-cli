import type { SourceKind } from "../../../evidence/types.js";

/**
 * A regex detection rule.
 *
 * Applicability is explicit via `applicableKinds`: a rule runs only on
 * files classified as one of those kinds. The previous implicit
 * cross-kind matching matrix is gone (see handoff report for the exact
 * output differences this produces).
 */
export type Pattern = {
  re: RegExp;
  findingType: string;
  controls: string[];
  applicableKinds: readonly SourceKind[];
};

/**
 * Detection rules. Rule order is significant: within a file, findings are
 * produced line by line and rule by rule, preserving the original output
 * order. `findingType` and `controls` values are unchanged.
 */
export const PATTERNS: Pattern[] = [
  {
    re: /consent/i,
    findingType: "consent_reference",
    controls: ["DPDP-CONSENT-COLLECT", "DPDP-CONSENT-NOTICE"],
    applicableKinds: ["CODE"],
  },
  {
    re: /withdraw.*consent|consent.*withdraw/i,
    findingType: "consent_withdrawal",
    controls: ["DPDP-CONSENT-WITHDRAW"],
    applicableKinds: ["CODE"],
  },
  {
    re: /(router|app)\.(delete|del)\(['"`].*(account|user|personal|data)/i,
    findingType: "deletion_endpoint",
    controls: ["DPDP-RIGHTS-ERASURE"],
    applicableKinds: ["CODE"],
  },
  {
    re: /(erase|erasure|right.?to.?be.?forgotten)/i,
    findingType: "erasure_logic",
    controls: ["DPDP-RIGHTS-ERASURE"],
    applicableKinds: ["CODE"],
  },
  {
    re: /(access.?request|data.?export|\/me\/data)/i,
    findingType: "access_endpoint",
    controls: ["DPDP-RIGHTS-ACCESS"],
    applicableKinds: ["CODE"],
  },
  {
    re: /grievance/i,
    findingType: "grievance_reference",
    controls: ["DPDP-RIGHTS-GRIEVANCE"],
    applicableKinds: ["CODE"],
  },
  {
    re: /(breach|incident.?response)/i,
    findingType: "breach_reference",
    controls: ["DPDP-BREACH-DETECT", "DPDP-BREACH-NOTIFY"],
    applicableKinds: ["CODE"],
  },
  {
    re: /retention/i,
    findingType: "retention_reference",
    controls: ["DPDP-RETENTION-SCHEDULE", "DPDP-RETENTION-LOGS"],
    applicableKinds: ["CODE"],
  },
  {
    re: /(LOG_RETENTION|RETENTION_DAYS|DATA_RETENTION)/i,
    findingType: "retention_config",
    controls: ["DPDP-RETENTION-LOGS", "DPDP-RETENTION-SCHEDULE"],
    applicableKinds: ["CONFIG"],
  },
  {
    re: /(privacy.?policy|notice)/i,
    findingType: "notice_language",
    controls: ["DPDP-CONSENT-NOTICE"],
    applicableKinds: ["DOCUMENT"],
  },
  {
    re: /(processor|subprocessor|data.?processing.?agreement|\bDPA\b)/i,
    findingType: "vendor_reference",
    controls: ["DPDP-VENDOR-INVENTORY", "DPDP-VENDOR-DPA"],
    applicableKinds: ["DOCUMENT"],
  },
];
