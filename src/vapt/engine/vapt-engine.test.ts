import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HttpCollector, TlsCollector } from "../collectors/types.js";
import { CheckRegistry } from "../checks/registry.js";
import type { VaptCheck, CheckContext, CheckResult } from "../checks/types.js";
import { VaptEngine } from "./vapt-engine.js";
import { parseScope } from "../scope/validate.js";
import type { VaptScope } from "../scope/types.js";
import { VaptError } from "../../shared/errors.js";

function makeScope(overrides: Record<string, unknown> = {}): VaptScope {
  return parseScope({
    target: { targetType: "URL", value: "https://app.example.com" },
    includedTargets: [],
    excludedTargets: [],
    profile: "web-baseline",
    mode: "passive",
    authorization: { authorizedBy: "tester", purpose: "test" },
    ...overrides,
  });
}

const CONFIG = {
  profile: "web-baseline",
  checkCategories: ["tls", "http-headers"],
  mode: "passive",
  timeoutMs: 1000,
  concurrency: 1,
  ratePerSecond: 5,
  safeMode: true,
  toolConfig: { engineVersion: "0.1.0", checkCatalogVersion: "1.0.0" },
} as const;

function makeCheck(
  checkId: string,
  run: (ctx: CheckContext) => Promise<CheckResult>,
): VaptCheck {
  return {
    checkId,
    name: checkId,
    category: "test",
    description: "test check",
    supportedTargetTypes: ["URL", "HOSTNAME", "IP"],
    defaultSeverity: "LOW",
    version: "1.0.0",
    executionRequirements: { passiveOnly: true, safeOnly: true },
    run,
  };
}

function recordingCollectors(): {
  http: HttpCollector & { calls: string[] };
  tls: TlsCollector & { calls: string[] };
} {
  const http = {
    calls: [] as string[],
    async get(url: string) {
      this.calls.push(url);
      return { url, method: "GET", status: 200, headers: [] };
    },
  };
  const tls = {
    calls: [] as string[],
    async probe(host: string, port: number) {
      this.calls.push(`${host}:${port}`);
      return { connected: true, protocolVersion: "TLSv1.3" };
    },
  };
  return { http, tls };
}

function engineWith(registry: CheckRegistry, collectors = recordingCollectors()) {
  return {
    engine: new VaptEngine({ registry, http: collectors.http, tls: collectors.tls }),
    collectors,
  };
}

describe("VaptEngine.run", () => {
  test("executes registered checks and normalizes findings", async () => {
    const registry = new CheckRegistry();
    registry.register(
      makeCheck("test/finding", async () => ({
        findings: [
          {
            checkId: "test/finding",
            category: "test",
            severity: "MEDIUM",
            title: "Something observed",
            target: { targetType: "URL", hostname: "app.example.com" },
            description: "observed",
            evidence: [{ kind: "observation", observedValue: "x" }],
          },
        ],
      })),
    );
    const { engine } = engineWith(registry);
    const summary = await engine.run(makeScope(), CONFIG);

    assert.equal(summary.checksExecuted.length, 1);
    assert.equal(summary.findings.length, 1);
    const finding = summary.findings[0]!;
    assert.match(finding.findingId, /^finding-/);
    assert.equal(finding.provenance.scanner, "dpdp-cli");
    assert.equal(finding.provenance.checkId, "test/finding");
    assert.equal(finding.provenance.checkVersion, "1.0.0");
    assert.equal(finding.provenance.source, "local-check");
    assert.ok(finding.observedAt);
    assert.equal(finding.evidenceRefs.length, 1);
    assert.equal(summary.evidence.length, 1);
    assert.equal(summary.evidence[0]!.findingId, finding.findingId);
    assert.match(summary.evidence[0]!.evidenceId, /^ev-/);
  });

  test("deduplicates within a scan by target|checkId|endpoint", async () => {
    const registry = new CheckRegistry();
    registry.register(
      makeCheck("test/dup", async () => ({
        findings: [
          {
            checkId: "test/dup",
            category: "test",
            severity: "LOW",
            title: "dup one",
            target: { targetType: "URL", hostname: "app.example.com", endpoint: "/a" },
            description: "first",
            evidence: [],
          },
          {
            checkId: "test/dup",
            category: "test",
            severity: "LOW",
            title: "dup two",
            target: { targetType: "URL", hostname: "app.example.com", endpoint: "/a" },
            description: "second",
            evidence: [],
          },
          {
            checkId: "test/dup",
            category: "test",
            severity: "LOW",
            title: "different endpoint",
            target: { targetType: "URL", hostname: "app.example.com", endpoint: "/b" },
            description: "third",
            evidence: [],
          },
          {
            checkId: "test/dup",
            category: "test",
            severity: "LOW",
            title: "different host",
            target: { targetType: "URL", hostname: "other.example.com", endpoint: "/a" },
            description: "fourth",
            evidence: [],
          },
        ],
      })),
    );
    const { engine } = engineWith(registry);
    const summary = await engine.run(makeScope(), CONFIG);
    assert.equal(summary.findings.length, 3);
  });

  test("a failing check is recorded as an issue, not an abort", async () => {
    const registry = new CheckRegistry();
    registry.register(
      makeCheck("test/broken", async () => {
        throw new Error("boom");
      }),
    );
    registry.register(
      makeCheck("test/fine", async () => ({ findings: [] })),
    );
    const { engine } = engineWith(registry);
    const summary = await engine.run(makeScope(), CONFIG);
    assert.equal(summary.issues.length, 1);
    assert.match(summary.issues[0]!.message, /test\/broken.*boom/);
    assert.equal(summary.checksExecuted.length, 1);
    assert.deepEqual(summary.checksExecuted, ["test/fine"]);
  });

  test("skipped checks are recorded with reasons", async () => {
    const registry = new CheckRegistry();
    registry.register(
      makeCheck("test/skip", async () => ({ findings: [], skipped: { reason: "no tls" } })),
    );
    const { engine } = engineWith(registry);
    const summary = await engine.run(makeScope(), CONFIG);
    assert.deepEqual(summary.checksSkipped, [{ checkId: "test/skip", reason: "no tls" }]);
    assert.equal(summary.checksExecuted.length, 0);
  });

  test("no checks for the target type is an engine error", async () => {
    const registry = new CheckRegistry();
    const { engine } = engineWith(registry);
    const scope = makeScope({
      target: { targetType: "SERVICE", value: "ssh" },
    });
    await assert.rejects(
      engine.run(scope, CONFIG),
      (err: unknown) =>
        err instanceof VaptError && err.code === "vapt.engine" && /No registered checks/.test(err.message),
    );
  });

  test("cancellation aborts between checks", async () => {
    const registry = new CheckRegistry();
    registry.register(makeCheck("test/a", async () => ({ findings: [] })));
    const { engine } = engineWith(registry);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      engine.run(makeScope(), CONFIG, controller.signal),
      (err: unknown) => err instanceof VaptError && /cancelled/.test(err.message),
    );
  });
});

describe("scope enforcement in the engine", () => {
  test("never contacts an excluded target (defense-in-depth; parseScope forbids it too)", async () => {
    const registry = new CheckRegistry();
    registry.register(makeCheck("test/x", async () => ({ findings: [] })));
    const { engine, collectors } = engineWith(registry);
    // Constructed directly (bypassing parseScope, which rejects this): the
    // engine must not trust its input and must refuse before any network I/O.
    const scope: VaptScope = {
      scopeVersion: 1,
      target: { targetType: "URL", value: "https://app.example.com", hostname: "app.example.com", protocol: "https" },
      includedTargets: [],
      excludedTargets: [
        { targetType: "URL", value: "https://app.example.com", hostname: "app.example.com", protocol: "https" },
      ],
      profile: "web-baseline",
      mode: "passive",
      authorization: { authorizedBy: "t", authorizedAt: "t", purpose: "t" },
    };
    await assert.rejects(
      engine.run(scope, CONFIG),
      (err: unknown) => err instanceof VaptError && err.code === "vapt.out_of_scope",
    );
    assert.equal(collectors.http.calls.length, 0, "no HTTP request must be made");
    assert.equal(collectors.tls.calls.length, 0, "no TLS probe must be made");
  });

  test("never contacts a port outside allowedPorts", async () => {
    const registry = new CheckRegistry();
    registry.register(makeCheck("test/x", async () => ({ findings: [] })));
    const { engine, collectors } = engineWith(registry);
    // http:// target without a port → httpPort 80, tlsPort 443; 80 is disallowed.
    const scope = makeScope({
      target: { targetType: "URL", value: "http://app.example.com" },
      allowedPorts: [443],
    });
    await assert.rejects(
      engine.run(scope, CONFIG),
      /not in allowedPorts/,
    );
    assert.equal(collectors.http.calls.length, 0);
    assert.equal(collectors.tls.calls.length, 0);
  });

  test("passes the resolved target to checks within scope", async () => {
    const registry = new CheckRegistry();
    let seen: CheckContext | undefined;
    registry.register(
      makeCheck("test/seen", async (ctx) => {
        seen = ctx;
        return { findings: [] };
      }),
    );
    const { engine } = engineWith(registry);
    await engine.run(makeScope(), CONFIG);
    assert.equal(seen?.host, "app.example.com");
    assert.equal(seen?.tlsPort, 443);
    assert.equal(seen?.baseUrl, "https://app.example.com/");
  });
});
