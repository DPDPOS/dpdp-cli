/**
 * Scope parsing + enforcement.
 *
 * `parseScope` validates untrusted input (CLI flags, stored JSON) into a
 * typed `VaptScope`, throwing `VaptError(vapt.scope)` with a clear message on
 * any invalid value. The gate functions are called by the engine **before any
 * network activity**: a target outside the declared scope is never contacted.
 */
import { isIP } from "node:net";
import type { VaptFindingTarget } from "../findings/types.js";
import { ERROR_CODES, VaptError } from "../../shared/errors.js";
import type { VaptScope, VaptTarget, VaptTargetType, VaptMode } from "./types.js";

export const TARGET_TYPES: readonly VaptTargetType[] = [
  "URL",
  "HOSTNAME",
  "IP",
  "APPLICATION",
  "SERVICE",
];

export const VAPT_MODES: readonly VaptMode[] = ["passive", "active-safe", "active"];

export const DEFAULT_PROFILE = "web-baseline";
export const DEFAULT_MODE: VaptMode = "passive";

function scopeError(message: string): VaptError {
  return new VaptError(ERROR_CODES.VAPT_SCOPE, message);
}

/** Resolved connection facts the engine derives from a scope target. */
export type ResolvedTarget = {
  host: string;
  scheme: "http" | "https";
  /** Port for HTTP(S) requests (scheme default unless overridden). */
  httpPort: number;
  /** Port for TLS probing (defaults to 443 unless explicitly set). */
  tlsPort: number;
  /** Origin URL (no path/query) used by HTTP checks. */
  baseUrl: string;
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function optionalPort(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const port = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw scopeError(`${label}.port must be an integer between 1 and 65535`);
  }
  return port;
}

export function parseTarget(raw: unknown, label: string): VaptTarget {
  if (typeof raw !== "object" || raw === null) throw scopeError(`${label} is missing`);
  const o = raw as Record<string, unknown>;
  const targetType = o.targetType;
  if (typeof targetType !== "string" || !TARGET_TYPES.includes(targetType as VaptTargetType)) {
    throw scopeError(`${label}.targetType must be one of: ${TARGET_TYPES.join(", ")}`);
  }
  const value = o.value;
  if (typeof value !== "string" || value.trim() === "") {
    throw scopeError(`${label}.value is required`);
  }
  const out: VaptTarget = { targetType: targetType as VaptTargetType, value: value.trim() };
  const port = optionalPort(o.port, label);
  if (port !== undefined) out.port = port;

  switch (out.targetType) {
    case "URL": {
      let u: URL;
      try {
        u = new URL(out.value);
      } catch {
        throw scopeError(`${label}.value is not a valid URL: ${out.value}`);
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw scopeError(`${label}.value must use the http or https scheme`);
      }
      if (!u.hostname) throw scopeError(`${label}.value must include a hostname`);
      out.hostname = u.hostname;
      out.protocol = u.protocol.slice(0, -1);
      out.url = out.value;
      if (u.port && out.port === undefined) out.port = Number(u.port);
      break;
    }
    case "HOSTNAME": {
      if (out.value.includes("://") || /[/\s]/.test(out.value)) {
        throw scopeError(`${label}.value is not a valid hostname: ${out.value}`);
      }
      out.hostname = out.value.toLowerCase();
      if (o.protocol === "http" || o.protocol === "https") out.protocol = o.protocol;
      break;
    }
    case "IP": {
      if (isIP(out.value) === 0) {
        throw scopeError(`${label}.value is not a valid IP address: ${out.value}`);
      }
      out.ip = out.value;
      if (o.protocol === "http" || o.protocol === "https") out.protocol = o.protocol;
      break;
    }
    case "APPLICATION":
    case "SERVICE": {
      if (o.protocol === "http" || o.protocol === "https") out.protocol = o.protocol;
      if (typeof o.hostname === "string" && o.hostname) out.hostname = o.hostname;
      if (out.targetType === "APPLICATION") out.application = out.value;
      break;
    }
  }
  return out;
}

function parseTargetList(raw: unknown, label: string): VaptTarget[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw scopeError(`${label} must be an array of targets`);
  return raw.map((item, i) => parseTarget(item, `${label}[${i}]`));
}

function parsePortList(raw: unknown): number[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw scopeError("allowedPorts must be an array of port numbers");
  if (raw.length === 0) return undefined;
  const ports = raw.map((p, i) => optionalPort(p, `allowedPorts[${i}]`)) as number[];
  if (new Set(ports).size !== ports.length) throw scopeError("allowedPorts must not contain duplicates");
  return ports;
}

function parseStringList(raw: unknown, label: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw scopeError(`${label} must be an array of strings`);
  const values = raw.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return values.length > 0 ? values : undefined;
}

export function parseMode(raw: unknown): VaptMode {
  if (raw === undefined || raw === null) return DEFAULT_MODE;
  if (typeof raw !== "string" || !VAPT_MODES.includes(raw as VaptMode)) {
    throw scopeError(`mode must be one of: ${VAPT_MODES.join(", ")}`);
  }
  return raw as VaptMode;
}

function parseAuthorization(raw: unknown): VaptScope["authorization"] {
  if (typeof raw !== "object" || raw === null) {
    throw scopeError("authorization is required (authorizedBy + purpose)");
  }
  const o = raw as Record<string, unknown>;
  const authorizedBy = o.authorizedBy;
  const purpose = o.purpose;
  if (typeof authorizedBy !== "string" || authorizedBy.trim() === "") {
    throw scopeError("authorization.authorizedBy is required");
  }
  if (typeof purpose !== "string" || purpose.trim() === "") {
    throw scopeError("authorization.purpose is required");
  }
  return {
    authorizedBy: authorizedBy.trim(),
    authorizedAt:
      typeof o.authorizedAt === "string" ? o.authorizedAt : new Date().toISOString(),
    expiresAt: typeof o.expiresAt === "string" && o.expiresAt ? o.expiresAt : undefined,
    purpose: purpose.trim(),
    reference: typeof o.reference === "string" && o.reference ? o.reference : undefined,
  };
}

/** Validate untrusted scope input into a typed VaptScope. Throws on invalid. */
export function parseScope(raw: unknown): VaptScope {
  if (typeof raw !== "object" || raw === null) throw scopeError("scope is missing");
  const o = raw as Record<string, unknown>;
  const scope: VaptScope = {
    scopeVersion:
      typeof o.scopeVersion === "number" && Number.isInteger(o.scopeVersion) && o.scopeVersion > 0
        ? o.scopeVersion
        : 1,
    target: parseTarget(o.target, "target"),
    includedTargets: parseTargetList(o.includedTargets, "includedTargets"),
    excludedTargets: parseTargetList(o.excludedTargets, "excludedTargets"),
    allowedPorts: parsePortList(o.allowedPorts),
    allowedServices: parseStringList(o.allowedServices, "allowedServices"),
    profile: typeof o.profile === "string" && o.profile.trim() ? o.profile.trim() : DEFAULT_PROFILE,
    mode: parseMode(o.mode),
    authorization: parseAuthorization(o.authorization),
  };
  // Sanity: the primary target must not be excluded.
  if (targetMatchesAny(scope, scope.target, scope.excludedTargets)) {
    throw scopeError("target must not be listed in excludedTargets");
  }
  return scope;
}

// ---------------------------------------------------------------------------
// Enforcement (scope gate)
// ---------------------------------------------------------------------------

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function targetHost(target: VaptTarget): string {
  return target.hostname ?? target.ip ?? target.value;
}

/** Do two targets refer to the same host on the same port (if both specify)? */
function targetMatches(a: VaptTarget, host: string, port?: number): boolean {
  if (normalizeHost(targetHost(a)) !== normalizeHost(host)) return false;
  if (a.port !== undefined && port !== undefined && a.port !== port) return false;
  return true;
}

function targetMatchesAny(scope: VaptScope, target: VaptTarget, list: VaptTarget[]): boolean {
  return list.some((t) => targetMatches(t, targetHost(target), target.port));
}

export function isExcluded(scope: VaptScope, host: string, port?: number): boolean {
  return scope.excludedTargets.some((t) => targetMatches(t, host, port));
}

export function isPortAllowed(scope: VaptScope, port: number): boolean {
  return scope.allowedPorts === undefined || scope.allowedPorts.includes(port);
}

export function isCovered(scope: VaptScope, host: string, port?: number): boolean {
  return [scope.target, ...scope.includedTargets].some((t) => targetMatches(t, host, port));
}

/**
 * The engine calls this before ANY network activity. Throws
 * `VaptError(vapt.out_of_scope)` when the host/port is excluded, outside the
 * declared scope, or on a disallowed port. Fail closed.
 */
export function assertTargetInScope(
  scope: VaptScope,
  host: string,
  port: number,
  label = "target",
): void {
  if (isExcluded(scope, host, port)) {
    throw new VaptError(
      ERROR_CODES.VAPT_OUT_OF_SCOPE,
      `Refusing to scan excluded ${label} ${host}${port ? `:${port}` : ""}. Remove it from excludedTargets or adjust the scope.`,
    );
  }
  if (!isPortAllowed(scope, port)) {
    throw new VaptError(
      ERROR_CODES.VAPT_OUT_OF_SCOPE,
      `Refusing to scan ${label} ${host}:${port}: port ${port} is not in allowedPorts (${scope.allowedPorts?.join(", ")}).`,
    );
  }
  if (!isCovered(scope, host, port)) {
    throw new VaptError(
      ERROR_CODES.VAPT_OUT_OF_SCOPE,
      `${label} ${host} is outside the declared VAPT scope. Add it to the target or includedTargets.`,
    );
  }
}

/** Derive the connection facts the engine needs from the scope target. */
export function resolveTarget(scope: VaptScope): ResolvedTarget {
  const t = scope.target;
  let scheme: "http" | "https" = t.protocol === "http" ? "http" : "https";
  let host: string;
  let urlPort: number | undefined;
  if (t.targetType === "URL") {
    let u: URL;
    try {
      u = new URL(t.value);
    } catch {
      throw scopeError(`Invalid target URL: ${t.value}`);
    }
    scheme = u.protocol === "http:" ? "http" : "https";
    host = u.hostname;
    if (u.port) urlPort = Number(u.port);
  } else {
    host = t.hostname ?? t.ip ?? t.value;
  }
  const httpPort = t.port ?? urlPort ?? (scheme === "https" ? 443 : 80);
  const tlsPort = t.port ?? urlPort ?? 443;
  const defaultHttpPort = scheme === "https" ? 443 : 80;
  const baseUrl = `${scheme}://${host}${httpPort !== defaultHttpPort ? `:${httpPort}` : ""}/`;
  return { host, scheme, httpPort, tlsPort, baseUrl };
}

/** Finding target record stamped by the engine from the resolved scope. */
export function findingTargetFromResolved(
  resolved: ResolvedTarget,
  scope: VaptScope,
): VaptFindingTarget {
  return {
    targetType: scope.target.targetType,
    hostname: scope.target.hostname ?? (scope.target.targetType === "URL" ? resolved.host : undefined),
    ip: scope.target.ip,
    url: scope.target.targetType === "URL" ? scope.target.value : undefined,
    port: resolved.httpPort,
    protocol: resolved.scheme,
  };
}
