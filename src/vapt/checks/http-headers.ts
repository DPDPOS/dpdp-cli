import type { EvidenceItemDraft, Severity } from "../findings/types.js";
import { maxSeverity } from "../findings/severity.js";
import type { CheckContext, CheckResult, VaptCheck } from "./types.js";

/**
 * Security headers whose absence is reported. Missing headers are
 * defense-in-depth signals, not assumed critical vulnerabilities: severities
 * stay LOW (INFO for the least impactful), per the phase brief.
 */
const HEADERS: { name: string; label: string; severity: Severity }[] = [
  { name: "strict-transport-security", label: "Strict-Transport-Security", severity: "LOW" },
  { name: "content-security-policy", label: "Content-Security-Policy", severity: "LOW" },
  { name: "x-content-type-options", label: "X-Content-Type-Options", severity: "LOW" },
  { name: "x-frame-options", label: "X-Frame-Options", severity: "LOW" },
  { name: "referrer-policy", label: "Referrer-Policy", severity: "INFO" },
];

function httpEvidence(
  ctx: CheckContext,
  obs: { method: string; url: string; status: number; headers: { name: string; value: string }[] },
): EvidenceItemDraft {
  return {
    kind: "http",
    observedValue: `${obs.status} ${obs.method} ${obs.url}`,
    http: {
      method: obs.method,
      url: obs.url,
      status: obs.status,
      headers: obs.headers,
    },
  };
}

export const securityHeadersCheck: VaptCheck = {
  checkId: "http/security-headers",
  name: "HTTP security headers",
  category: "http-headers",
  description:
    "Observes a response and reports missing hardening headers (HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy).",
  supportedTargetTypes: ["URL", "HOSTNAME", "IP"],
  defaultSeverity: "LOW",
  version: "1.0.0",
  executionRequirements: { passiveOnly: true, safeOnly: true },
  async run(ctx: CheckContext): Promise<CheckResult> {
    const obs = await ctx.http.get(ctx.baseUrl);
    if (obs.status === 0) {
      return {
        findings: [],
        skipped: { reason: `HTTP request to ${ctx.baseUrl} failed (${obs.error ?? "unreachable"})` },
      };
    }
    const evidence = httpEvidence(ctx, obs);
    const present = new Set(obs.headers.map((h) => h.name.toLowerCase()));
    const missing = HEADERS.filter((h) => !present.has(h.name));
    if (missing.length === 0) return { findings: [] };
    const severity = missing.reduce<Severity>(
      (max, h) => maxSeverity(max, h.severity),
      "INFO",
    );
    const names = missing.map((h) => h.label).join(", ");
    return {
      findings: [
        {
          checkId: this.checkId,
          category: "http-headers",
          severity,
          title: "Security headers missing",
          target: ctx.target,
          description: `Response from ${obs.url} is missing security headers: ${names}. Missing headers are not necessarily vulnerabilities by themselves, but they reduce defense-in-depth.`,
          recommendation: `Add the missing response headers: ${names}.`,
          remediationPriority: "scheduled",
          evidence: [evidence],
        },
      ],
    };
  },
};
