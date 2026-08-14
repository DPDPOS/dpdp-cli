import type { HttpCollector, TlsCollector } from "../collectors/types.js";
import type { RawVaptFinding, Severity, VaptFindingTarget } from "../findings/types.js";
import type { VaptScanConfig } from "../profile/types.js";
import type { VaptTargetType } from "../scope/types.js";

/**
 * Declarative VAPT check (Phase 3 design, `docs/vapt/02-data-contract.md` §6).
 * New checks are added as data objects registered into the CheckRegistry —
 * the VAPT engine never changes.
 */
export type VaptCheck = {
  checkId: string;
  name: string;
  category: string;
  description: string;
  supportedTargetTypes: VaptTargetType[];
  /** Fallback when a finding has no meaningful severity of its own. */
  defaultSeverity: Severity;
  version: string;
  executionRequirements?: {
    protocol?: string[];
    needsAuth?: boolean;
    passiveOnly?: boolean;
    safeOnly?: boolean;
  };
  run(context: CheckContext): Promise<CheckResult>;
};

export type CheckContext = {
  /** Finding target stamped from the resolved scope. */
  target: VaptFindingTarget;
  host: string;
  httpPort: number;
  tlsPort: number;
  scheme: "http" | "https";
  baseUrl: string;
  config: VaptScanConfig;
  http: HttpCollector;
  tls: TlsCollector;
};

export type CheckResult = {
  /** Findings to emit (each carries its own inline evidence drafts). */
  findings: RawVaptFinding[];
  /** When set, the check could not produce observations (recorded, not an error). */
  skipped?: { reason: string };
};
