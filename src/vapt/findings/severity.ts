import { SEVERITIES, type Severity } from "./types.js";

/**
 * Normalize a severity value into the 5-point DPDPOS model
 * (INFO | LOW | MEDIUM | HIGH | CRITICAL).
 *
 * Check-produced values are typed `Severity`, so unmapped values only occur
 * when importing external-tool output later. Unmapped values are never
 * silently upgraded: they fall back to the check's default severity and are
 * flagged so the caller can surface a warning. Severity is independent of
 * DPDP compliance scoring.
 */
export function normalizeSeverity(
  value: unknown,
  fallback: Severity,
): { severity: Severity; unmapped: boolean } {
  if (typeof value === "string" && (SEVERITIES as readonly string[]).includes(value)) {
    return { severity: value as Severity, unmapped: false };
  }
  return { severity: fallback, unmapped: true };
}

const RANK: Record<Severity, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

/** The more severe of two severities. */
export function maxSeverity(a: Severity, b: Severity): Severity {
  return RANK[b] > RANK[a] ? b : a;
}
