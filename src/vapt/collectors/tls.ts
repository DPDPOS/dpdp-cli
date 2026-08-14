import { isIP } from "node:net";
import tls from "node:tls";
import type { TlsCollector, TlsObservation } from "./types.js";

function formatName(name: Record<string, string | string[] | undefined>): string {
  return Object.entries(name)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v ?? ""}`)
    .join(", ");
}

/**
 * Passive TLS observation collector.
 *
 * Connects with `rejectUnauthorized: false` because we are *observing* the
 * peer certificate (including invalid/self-signed ones), not validating it —
 * validation results are reported as findings, not as connection failures.
 * Certificates, negotiated protocol and cipher are extracted for evidence;
 * the connection is destroyed immediately after the handshake.
 */
export class NodeTlsCollector implements TlsCollector {
  constructor(private readonly timeoutMs = 10_000) {}

  probe(host: string, port: number): Promise<TlsObservation> {
    return new Promise((resolve) => {
      let settled = false;
      let socket: tls.TLSSocket | undefined;
      const finish = (obs: TlsObservation): void => {
        if (settled) return;
        settled = true;
        socket?.destroy();
        resolve(obs);
      };

      socket = tls.connect(
        {
          host,
          port,
          // RFC 6066 forbids SNI for IP literals; only set it for hostnames.
          servername: isIP(host) === 0 ? host : undefined,
          rejectUnauthorized: false,
          timeout: this.timeoutMs,
        },
        () => {
          let cert: tls.PeerCertificate | undefined;
          try {
            cert = socket?.getPeerCertificate();
          } catch {
            cert = undefined;
          }
          const obs: TlsObservation = {
            connected: true,
            protocolVersion: socket?.getProtocol() ?? undefined,
            cipherSuite: socket?.getCipher()?.name,
          };
          if (cert && cert.subject) {
            const subject = formatName(cert.subject);
            obs.certificate = {
              subject,
              issuer: cert.issuer ? formatName(cert.issuer) : undefined,
              validFrom: cert.valid_from ? new Date(cert.valid_from).toISOString() : undefined,
              validTo: cert.valid_to ? new Date(cert.valid_to).toISOString() : undefined,
              selfSigned: cert.issuer ? subject === formatName(cert.issuer) : undefined,
            };
          }
          if (cert) {
            try {
              tls.checkServerIdentity(host, cert);
            } catch {
              obs.hostnameMismatch = true;
            }
          }
          finish(obs);
        },
      );
      socket.on("error", (err) => finish({ connected: false, error: err.message }));
      socket.on("timeout", () => finish({ connected: false, error: "timeout" }));
    });
  }
}
