import type { TlsObservation } from "../collectors/types.js";
import type { EvidenceItemDraft, Severity } from "../findings/types.js";
import { maxSeverity } from "../findings/severity.js";
import type { CheckContext, CheckResult, VaptCheck } from "./types.js";

const TLS_SUPPORTED: VaptCheck["supportedTargetTypes"] = ["URL", "HOSTNAME", "IP"];

function tlsEvidence(obs: TlsObservation): EvidenceItemDraft {
  return {
    kind: "tls",
    observedValue: obs.connected
      ? `TLS handshake ok (${obs.protocolVersion ?? "unknown"})`
      : `TLS handshake failed${obs.error ? `: ${obs.error}` : ""}`,
    tls: {
      version: obs.protocolVersion,
      cipherSuite: obs.cipherSuite,
      certificate: obs.certificate,
    },
  };
}

/** Probes are shared by all TLS checks; a failed handshake is not an error. */
async function probeOrSkip(
  ctx: CheckContext,
): Promise<{ obs: TlsObservation } | { skipped: { reason: string } }> {
  const obs = await ctx.tls.probe(ctx.host, ctx.tlsPort);
  if (!obs.connected) {
    return {
      skipped: {
        reason: `TLS handshake with ${ctx.host}:${ctx.tlsPort} failed${obs.error ? ` (${obs.error})` : ""}`,
      },
    };
  }
  return { obs };
}

// ---------------------------------------------------------------------------
// tls/https-availability
// ---------------------------------------------------------------------------

export const httpsAvailabilityCheck: VaptCheck = {
  checkId: "tls/https-availability",
  name: "HTTPS availability",
  category: "tls",
  description:
    "Probes whether the target offers TLS on its service port; HTTPS protects data in transit.",
  supportedTargetTypes: TLS_SUPPORTED,
  defaultSeverity: "MEDIUM",
  version: "1.0.0",
  executionRequirements: { passiveOnly: true, safeOnly: true },
  async run(ctx: CheckContext): Promise<CheckResult> {
    const obs = await ctx.tls.probe(ctx.host, ctx.tlsPort);
    if (obs.connected) return { findings: [] };
    return {
      findings: [
        {
          checkId: this.checkId,
          category: "tls",
          severity: "MEDIUM",
          title: "HTTPS not available",
          target: ctx.target,
          description: `Could not establish a TLS connection to ${ctx.host}:${ctx.tlsPort}${
            obs.error ? ` (${obs.error})` : ""
          }. Traffic to this target is not protected in transit.`,
          recommendation:
            "Enable TLS on the service port and require HTTPS for all traffic.",
          remediationPriority: "scheduled",
          evidence: [tlsEvidence(obs)],
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// tls/certificate-validity
// ---------------------------------------------------------------------------

export const certificateValidityCheck: VaptCheck = {
  checkId: "tls/certificate-validity",
  name: "TLS certificate validity",
  category: "tls",
  description:
    "Observes the presented TLS certificate and reports expiry, not-yet-valid, self-signed and hostname-mismatch conditions.",
  supportedTargetTypes: TLS_SUPPORTED,
  defaultSeverity: "MEDIUM",
  version: "1.0.0",
  executionRequirements: { passiveOnly: true, safeOnly: true },
  async run(ctx: CheckContext): Promise<CheckResult> {
    const result = await probeOrSkip(ctx);
    if ("skipped" in result) return { findings: [], skipped: result.skipped };
    const { obs } = result;
    if (!obs.certificate) {
      return { findings: [], skipped: { reason: "no peer certificate presented" } };
    }
    const issues: string[] = [];
    let severity: Severity = "INFO";
    const now = Date.now();
    if (obs.certificate.validTo && now > new Date(obs.certificate.validTo).getTime()) {
      issues.push("certificate is expired");
      severity = maxSeverity(severity, "HIGH");
    }
    if (obs.certificate.validFrom && now < new Date(obs.certificate.validFrom).getTime()) {
      issues.push("certificate is not yet valid");
      severity = maxSeverity(severity, "MEDIUM");
    }
    if (obs.certificate.selfSigned) {
      issues.push("certificate is self-signed");
      severity = maxSeverity(severity, "MEDIUM");
    }
    if (obs.hostnameMismatch) {
      issues.push("certificate hostname does not match the target");
      severity = maxSeverity(severity, "HIGH");
    }
    if (issues.length === 0) return { findings: [] };
    return {
      findings: [
        {
          checkId: this.checkId,
          category: "tls",
          severity,
          title: "TLS certificate issues detected",
          target: ctx.target,
          description: `TLS certificate for ${ctx.host}:${ctx.tlsPort}: ${issues.join("; ")}.`,
          recommendation:
            "Replace or reconfigure the TLS certificate (valid dates, trusted CA, matching hostname).",
          remediationPriority: severity === "HIGH" ? "immediate" : "scheduled",
          evidence: [tlsEvidence(obs)],
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// tls/protocol-version
// ---------------------------------------------------------------------------

const DEPRECATED_PROTOCOLS = new Set(["TLSv1", "TLSv1.1", "SSLv3"]);

export const protocolVersionCheck: VaptCheck = {
  checkId: "tls/protocol-version",
  name: "TLS protocol version",
  category: "tls",
  description:
    "Reports when the target negotiates a deprecated TLS protocol version (TLS 1.0/1.1).",
  supportedTargetTypes: TLS_SUPPORTED,
  defaultSeverity: "MEDIUM",
  version: "1.0.0",
  executionRequirements: { passiveOnly: true, safeOnly: true },
  async run(ctx: CheckContext): Promise<CheckResult> {
    const result = await probeOrSkip(ctx);
    if ("skipped" in result) return { findings: [], skipped: result.skipped };
    const { obs } = result;
    const version = obs.protocolVersion ?? "";
    if (!DEPRECATED_PROTOCOLS.has(version)) return { findings: [] };
    return {
      findings: [
        {
          checkId: this.checkId,
          category: "tls",
          severity: "MEDIUM",
          title: "Deprecated TLS protocol version in use",
          target: ctx.target,
          description: `Server at ${ctx.host}:${ctx.tlsPort} negotiates ${version}, which is deprecated and lacks modern cryptographic protections.`,
          recommendation: "Disable TLS 1.0/1.1 (and older) and require TLS 1.2 or TLS 1.3.",
          remediationPriority: "immediate",
          evidence: [tlsEvidence(obs)],
        },
      ],
    };
  },
};
