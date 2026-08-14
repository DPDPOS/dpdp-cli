import type { VaptMode } from "../scope/types.js";

/**
 * Scan configuration snapshot (Phase 3 design, `docs/vapt/02-data-contract.md`
 * §4). Persisted with every scan so any run is reproducible. User
 * configuration only — never contains secrets or generated results.
 */
export type VaptScanConfig = {
  profile: string;
  checkCategories: string[];
  mode: VaptMode;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Max parallel checks (execution is sequential in this build, so 1). */
  concurrency: number;
  ratePerSecond: number;
  /** Non-destructive guarantee. */
  safeMode: boolean;
  toolConfig: {
    engineVersion: string;
    checkCatalogVersion: string;
    [key: string]: unknown;
  };
};
