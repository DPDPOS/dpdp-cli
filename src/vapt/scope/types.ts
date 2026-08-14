/**
 * VAPT scope model (Phase 3 design, `docs/vapt/02-data-contract.md` §2–3).
 *
 * The scope is the authorization contract: a scan refuses to start without a
 * validated scope, and the engine never contacts anything outside it.
 */

export type VaptTargetType = "URL" | "HOSTNAME" | "IP" | "APPLICATION" | "SERVICE";

export type VaptTarget = {
  targetType: VaptTargetType;
  /** Primary identifier as provided (URL, hostname, IP, app/service id). */
  value: string;
  hostname?: string;
  ip?: string;
  url?: string;
  port?: number;
  protocol?: string; // "http" | "https" (or future service protocols)
  application?: string;
};

export type VaptMode = "passive" | "active-safe" | "active";

export type VaptScope = {
  scopeVersion: number;
  target: VaptTarget;
  includedTargets: VaptTarget[];
  excludedTargets: VaptTarget[];
  /** When set, only these ports may be contacted (engine-enforced). */
  allowedPorts?: number[];
  /** When set, only these services may be assessed. */
  allowedServices?: string[];
  profile: string;
  mode: VaptMode;
  authorization: {
    authorizedBy: string;
    authorizedAt: string;
    expiresAt?: string;
    purpose: string;
    reference?: string;
  };
};
