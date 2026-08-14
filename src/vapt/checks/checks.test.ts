import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HttpObservation, TlsObservation } from "../collectors/types.js";
import { certificateValidityCheck, httpsAvailabilityCheck, protocolVersionCheck } from "./tls.js";
import { securityHeadersCheck } from "./http-headers.js";
import type { CheckContext, VaptCheck } from "./types.js";
import type { VaptFindingTarget } from "../findings/types.js";
import { VAPT_SCANNER_NAME } from "../profile/default.js";

const TARGET: VaptFindingTarget = {
  targetType: "URL",
  hostname: "app.example.com",
  url: "https://app.example.com",
  port: 443,
  protocol: "https",
};

function fakeTls(obs: TlsObservation): CheckContext["tls"] {
  return { probe: async () => obs };
}

function fakeHttp(obs: HttpObservation): CheckContext["http"] {
  return { get: async () => obs };
}

function ctx(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    target: TARGET,
    host: "app.example.com",
    httpPort: 443,
    tlsPort: 443,
    scheme: "https",
    baseUrl: "https://app.example.com/",
    config: {
      profile: "web-baseline",
      checkCategories: ["tls", "http-headers"],
      mode: "passive",
      timeoutMs: 1000,
      concurrency: 1,
      ratePerSecond: 5,
      safeMode: true,
      toolConfig: { engineVersion: "0.1.0", checkCatalogVersion: "1.0.0" },
    },
    http: fakeHttp({ url: "https://app.example.com/", method: "GET", status: 200, headers: [] }),
    tls: fakeTls({ connected: true, protocolVersion: "TLSv1.3" }),
    ...overrides,
  };
}

async function run(check: VaptCheck, context: CheckContext) {
  return check.run(context);
}

describe("tls/https-availability", () => {
  test("no finding when TLS is available", async () => {
    const result = await run(httpsAvailabilityCheck, ctx());
    assert.equal(result.findings.length, 0);
  });

  test("MEDIUM finding when TLS handshake fails", async () => {
    const result = await run(
      httpsAvailabilityCheck,
      ctx({ tls: fakeTls({ connected: false, error: "ECONNREFUSED" }) }),
    );
    assert.equal(result.findings.length, 1);
    const finding = result.findings[0]!;
    assert.equal(finding.severity, "MEDIUM");
    assert.equal(finding.checkId, "tls/https-availability");
    assert.equal(finding.category, "tls");
    assert.match(finding.description, /ECONNREFUSED/);
    assert.equal(finding.evidence.length, 1);
    assert.equal(finding.evidence[0]!.kind, "tls");
    assert.equal(finding.evidence[0]!.observedValue, "TLS handshake failed: ECONNREFUSED");
  });
});

describe("tls/certificate-validity", () => {
  const cert = {
    subject: "CN=app.example.com",
    issuer: "CN=Some CA",
    validFrom: "2020-01-01T00:00:00.000Z",
    validTo: "2030-01-01T00:00:00.000Z",
    selfSigned: false,
  };

  test("no finding for a valid certificate", async () => {
    const result = await run(
      certificateValidityCheck,
      ctx({ tls: fakeTls({ connected: true, certificate: cert }) }),
    );
    assert.equal(result.findings.length, 0);
  });

  test("expired certificate is HIGH", async () => {
    const result = await run(
      certificateValidityCheck,
      ctx({
        tls: fakeTls({
          connected: true,
          certificate: { ...cert, validTo: "2020-01-01T00:00:00.000Z" },
        }),
      }),
    );
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.severity, "HIGH");
    assert.match(result.findings[0]!.description, /expired/);
  });

  test("self-signed certificate is MEDIUM", async () => {
    const result = await run(
      certificateValidityCheck,
      ctx({
        tls: fakeTls({
          connected: true,
          certificate: { ...cert, selfSigned: true },
          hostnameMismatch: false,
        }),
      }),
    );
    assert.equal(result.findings[0]!.severity, "MEDIUM");
    assert.match(result.findings[0]!.description, /self-signed/);
  });

  test("hostname mismatch is HIGH", async () => {
    const result = await run(
      certificateValidityCheck,
      ctx({
        tls: fakeTls({ connected: true, certificate: cert, hostnameMismatch: true }),
      }),
    );
    assert.equal(result.findings[0]!.severity, "HIGH");
    assert.match(result.findings[0]!.description, /hostname/);
  });

  test("failed handshake skips instead of erroring", async () => {
    const result = await run(
      certificateValidityCheck,
      ctx({ tls: fakeTls({ connected: false, error: "timeout" }) }),
    );
    assert.equal(result.findings.length, 0);
    assert.equal(result.skipped?.reason, "TLS handshake with app.example.com:443 failed (timeout)");
  });
});

describe("tls/protocol-version", () => {
  test("deprecated TLSv1 is MEDIUM", async () => {
    const result = await run(
      protocolVersionCheck,
      ctx({ tls: fakeTls({ connected: true, protocolVersion: "TLSv1" }) }),
    );
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.severity, "MEDIUM");
    assert.match(result.findings[0]!.title, /Deprecated TLS protocol/);
  });

  test("TLSv1.2 is fine", async () => {
    const result = await run(
      protocolVersionCheck,
      ctx({ tls: fakeTls({ connected: true, protocolVersion: "TLSv1.2" }) }),
    );
    assert.equal(result.findings.length, 0);
  });
});

describe("http/security-headers", () => {
  function headersResponse(present: string[]): CheckContext {
    return ctx({
      http: fakeHttp({
        url: "https://app.example.com/",
        method: "GET",
        status: 200,
        headers: present.map((name) => ({ name, value: "present" })),
      }),
    });
  }

  test("no finding when all headers present", async () => {
    const result = await run(
      securityHeadersCheck,
      headersResponse([
        "strict-transport-security",
        "content-security-policy",
        "x-content-type-options",
        "x-frame-options",
        "referrer-policy",
      ]),
    );
    assert.equal(result.findings.length, 0);
  });

  test("missing headers produce one LOW finding listing them", async () => {
    const result = await run(
      securityHeadersCheck,
      headersResponse(["x-content-type-options"]),
    );
    assert.equal(result.findings.length, 1);
    const finding = result.findings[0]!;
    assert.equal(finding.checkId, "http/security-headers");
    assert.equal(finding.severity, "LOW");
    assert.match(finding.description, /Strict-Transport-Security/);
    assert.match(finding.description, /Content-Security-Policy/);
    assert.equal(finding.evidence.length, 1);
    assert.equal(finding.evidence[0]!.kind, "http");
  });

  test("request failure skips instead of erroring", async () => {
    const result = await run(
      securityHeadersCheck,
      ctx({
        http: fakeHttp({ url: "https://app.example.com/", method: "GET", status: 0, headers: [], error: "ETIMEDOUT" }),
      }),
    );
    assert.equal(result.findings.length, 0);
    assert.match(result.skipped?.reason ?? "", /ETIMEDOUT/);
  });
});

describe("check metadata", () => {
  test("all checks carry designed metadata and provenance-friendly versions", () => {
    for (const check of [
      httpsAvailabilityCheck,
      certificateValidityCheck,
      protocolVersionCheck,
      securityHeadersCheck,
    ]) {
      assert.ok(check.checkId.includes("/"), "checkId uses category/name form");
      assert.ok(check.name.length > 0);
      assert.ok(check.category.length > 0);
      assert.ok(check.description.length > 0);
      assert.ok(check.supportedTargetTypes.length > 0);
      assert.ok(check.version.length > 0);
      assert.ok(check.executionRequirements?.passiveOnly, `${check.checkId} must be passive`);
      assert.ok(check.executionRequirements?.safeOnly, `${check.checkId} must be safe`);
    }
    assert.equal(VAPT_SCANNER_NAME, "dpdp-cli");
  });
});
