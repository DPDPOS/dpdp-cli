import type { HttpCollector, HttpObservation } from "./types.js";

export const VAPT_USER_AGENT = "dpdp-cli-vapt/0.1.0";

/**
 * Allowlist of response headers recorded in evidence. Headers that can carry
 * credentials or session material (authorization, cookie, set-cookie, ...)
 * are never stored; request bodies and response bodies are never stored.
 */
const ALLOWED_HEADERS = new Set([
  "server",
  "content-type",
  "content-length",
  "location",
  "cache-control",
  "strict-transport-security",
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
]);

/**
 * Passive HTTP collector built on global `fetch`.
 *
 * Safety: `redirect: "manual"` — redirects are never followed (a redirect
 * could point outside the authorized scope); the Location header, when
 * allowlisted, is recorded for the check to reason about. Request timeouts
 * use `AbortSignal.timeout`.
 */
export class NodeHttpCollector implements HttpCollector {
  constructor(private readonly timeoutMs = 10_000) {}

  async get(url: string): Promise<HttpObservation> {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          "User-Agent": VAPT_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        },
      });
      const headers: { name: string; value: string }[] = [];
      for (const [name, value] of res.headers) {
        if (ALLOWED_HEADERS.has(name.toLowerCase())) headers.push({ name, value });
      }
      return {
        url,
        method: "GET",
        status: res.status,
        statusText: res.statusText,
        headers,
        redirectLocation: res.headers.get("location") ?? undefined,
        responseTimeMs: Date.now() - started,
      };
    } catch (err) {
      return {
        url,
        method: "GET",
        status: 0,
        headers: [],
        error: err instanceof Error ? err.message : String(err),
        responseTimeMs: Date.now() - started,
      };
    }
  }
}
