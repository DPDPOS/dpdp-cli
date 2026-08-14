import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isVaptError } from "../../shared/errors.js";
import {
  assertTargetInScope,
  isCovered,
  isExcluded,
  isPortAllowed,
  parseScope,
  resolveTarget,
} from "./validate.js";
import type { VaptScope } from "./types.js";

function baseScope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target: { targetType: "URL", value: "https://app.example.com" },
    includedTargets: [],
    excludedTargets: [],
    profile: "web-baseline",
    mode: "passive",
    authorization: { authorizedBy: "tester@corp", purpose: "release assessment" },
    ...overrides,
  };
}

function parse(overrides: Record<string, unknown> = {}): VaptScope {
  return parseScope(baseScope(overrides));
}

function expectScopeError(raw: unknown, pattern: RegExp): void {
  assert.throws(
    () => parseScope(raw),
    (err: unknown) => isVaptError(err) && err.code === "vapt.scope" && pattern.test(err.message),
    String(pattern),
  );
}

describe("parseScope — valid scopes", () => {
  test("URL target extracts hostname, protocol and port", () => {
    const scope = parse();
    assert.equal(scope.target.targetType, "URL");
    assert.equal(scope.target.hostname, "app.example.com");
    assert.equal(scope.target.protocol, "https");
    assert.equal(scope.scopeVersion, 1);
    assert.equal(scope.mode, "passive");
    assert.equal(scope.authorization.authorizedBy, "tester@corp");
  });

  test("URL target with explicit port keeps it", () => {
    const scope = parse({ target: { targetType: "URL", value: "https://app.example.com:8443" } });
    assert.equal(scope.target.port, 8443);
    const resolved = resolveTarget(scope);
    assert.equal(resolved.httpPort, 8443);
    assert.equal(resolved.tlsPort, 8443);
    assert.equal(resolved.baseUrl, "https://app.example.com:8443/");
  });

  test("hostname and IP targets parse", () => {
    const host = parse({ target: { targetType: "HOSTNAME", value: "api.example.com" } });
    assert.equal(host.target.hostname, "api.example.com");
    const ip = parse({ target: { targetType: "IP", value: "10.0.0.5" } });
    assert.equal(ip.target.ip, "10.0.0.5");
  });

  test("excluded/included targets and allowed ports are kept", () => {
    const scope = parse({
      includedTargets: [{ targetType: "URL", value: "https://sub.example.com" }],
      // Exclusions are host+port level: a different host, not a path of the primary.
      excludedTargets: [{ targetType: "URL", value: "https://staging.example.com" }],
      allowedPorts: [443],
    });
    assert.equal(scope.includedTargets.length, 1);
    assert.equal(scope.excludedTargets.length, 1);
    assert.deepEqual(scope.allowedPorts, [443]);
  });

  test("resolveTarget for http URL defaults ports per scheme", () => {
    const scope = parse({ target: { targetType: "URL", value: "http://app.example.com" } });
    const resolved = resolveTarget(scope);
    assert.equal(resolved.scheme, "http");
    assert.equal(resolved.httpPort, 80);
    assert.equal(resolved.tlsPort, 443);
    assert.equal(resolved.baseUrl, "http://app.example.com/");
  });
});

describe("parseScope — invalid scopes are rejected", () => {
  test("missing target", () => {
    expectScopeError(baseScope({ target: undefined }), /target is missing/);
  });
  test("unknown target type", () => {
    expectScopeError(baseScope({ target: { targetType: "FTP", value: "x" } }), /targetType must be one of/);
  });
  test("invalid URL", () => {
    expectScopeError(
      baseScope({ target: { targetType: "URL", value: "not a url" } }),
      /not a valid URL/,
    );
  });
  test("non-http scheme", () => {
    expectScopeError(
      baseScope({ target: { targetType: "URL", value: "ftp://x.example.com" } }),
      /http or https/,
    );
  });
  test("invalid IP", () => {
    expectScopeError(
      baseScope({ target: { targetType: "IP", value: "999.1.1.1" } }),
      /not a valid IP/,
    );
  });
  test("bad port", () => {
    expectScopeError(
      baseScope({ target: { targetType: "HOSTNAME", value: "x.com", port: 70000 } }),
      /port must be an integer/,
    );
  });
  test("invalid mode", () => {
    expectScopeError(baseScope({ mode: "destructive" }), /mode must be one of/);
  });
  test("missing authorization", () => {
    expectScopeError(baseScope({ authorization: undefined }), /authorization is required/);
  });
  test("missing authorizedBy", () => {
    expectScopeError(
      baseScope({ authorization: { purpose: "x" } }),
      /authorizedBy is required/,
    );
  });
  test("primary target must not be excluded", () => {
    expectScopeError(
      baseScope({
        excludedTargets: [{ targetType: "URL", value: "https://app.example.com" }],
      }),
      /must not be listed in excludedTargets/,
    );
  });
});

describe("scope gate — enforcement", () => {
  test("covered target is allowed", () => {
    const scope = parse();
    assert.equal(isCovered(scope, "app.example.com", 443), true);
    assert.doesNotThrow(() => assertTargetInScope(scope, "app.example.com", 443));
  });

  test("excluded target is refused", () => {
    const scope = parse({
      excludedTargets: [{ targetType: "URL", value: "https://staging.example.com" }],
    });
    assert.equal(isExcluded(scope, "staging.example.com", 443), true);
    assert.equal(isExcluded(scope, "app.example.com", 443), false);
    assert.throws(
      () => assertTargetInScope(scope, "staging.example.com", 443),
      (err: unknown) => isVaptError(err) && err.code === "vapt.out_of_scope" && /excluded/.test((err as Error).message),
    );
  });

  test("port outside allowedPorts is refused", () => {
    const scope = parse({ allowedPorts: [443] });
    assert.equal(isPortAllowed(scope, 443), true);
    assert.equal(isPortAllowed(scope, 8080), false);
    assert.throws(
      () => assertTargetInScope(scope, "app.example.com", 8080),
      /not in allowedPorts/,
    );
  });

  test("uncovered host is refused", () => {
    const scope = parse();
    assert.throws(
      () => assertTargetInScope(scope, "evil.example.net", 443),
      /outside the declared VAPT scope/,
    );
  });

  test("included target is covered", () => {
    const scope = parse({
      includedTargets: [{ targetType: "URL", value: "https://sub.example.com" }],
    });
    assert.equal(isCovered(scope, "sub.example.com", 443), true);
  });
});
