/**
 * VAPT collectors obtain raw observations about an authorized target.
 * Small, injectable interfaces so checks and the engine are testable without
 * real network access. Collectors never store bodies, credentials or
 * secret-bearing headers.
 */

export type HttpObservation = {
  url: string;
  method: string;
  /** 0 when the request failed (see `error`). */
  status: number;
  statusText?: string;
  /** Sanitized headers: allowlist only, never auth/cookie/set-cookie. */
  headers: { name: string; value: string }[];
  redirectLocation?: string;
  responseTimeMs?: number;
  error?: string;
};

export interface HttpCollector {
  get(url: string): Promise<HttpObservation>;
}

export type TlsObservation = {
  connected: boolean;
  protocolVersion?: string;
  cipherSuite?: string;
  certificate?: {
    subject?: string;
    issuer?: string;
    validFrom?: string;
    validTo?: string;
    selfSigned?: boolean;
  };
  hostnameMismatch?: boolean;
  error?: string;
};

export interface TlsCollector {
  probe(host: string, port: number): Promise<TlsObservation>;
}
