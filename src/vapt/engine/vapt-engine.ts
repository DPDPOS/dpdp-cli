import type { CheckContext, CheckResult } from "../checks/types.js";
import { CheckRegistry } from "../checks/registry.js";
import type { HttpCollector, TlsCollector } from "../collectors/types.js";
import { deduplicateFindings } from "../findings/deduplicate.js";
import { normalizeFinding } from "../findings/normalize.js";
import type { EvidenceItem, VaptFinding } from "../findings/types.js";
import { VAPT_CLI_VERSION } from "../profile/default.js";
import type { VaptScanConfig } from "../profile/types.js";
import type { VaptScope } from "../scope/types.js";
import {
  assertTargetInScope,
  findingTargetFromResolved,
  resolveTarget,
} from "../scope/validate.js";
import { ERROR_CODES, VaptError } from "../../shared/errors.js";
import type { VaptIssue, VaptScanSummary } from "./types.js";

export type VaptEngineOptions = {
  registry: CheckRegistry;
  http: HttpCollector;
  tls: TlsCollector;
  /** Injectable clock for tests. */
  now?: () => Date;
};

/**
 * Orchestrates one VAPT scan:
 *
 *   resolve target → scope gate (fail closed) → run registered checks
 *     → normalize findings → attach evidence → deduplicate → summary
 *
 * The engine contains no check-specific logic (checks are data in the
 * registry), no storage access, and no Commander dependency. It never
 * contacts anything outside the declared scope.
 */
export class VaptEngine {
  private readonly registry: CheckRegistry;
  private readonly http: HttpCollector;
  private readonly tls: TlsCollector;
  private readonly now: () => Date;

  constructor(options: VaptEngineOptions) {
    this.registry = options.registry;
    this.http = options.http;
    this.tls = options.tls;
    this.now = options.now ?? (() => new Date());
  }

  async run(
    scope: VaptScope,
    config: VaptScanConfig,
    signal?: AbortSignal,
  ): Promise<VaptScanSummary> {
    const started = Date.now();
    const issues: VaptIssue[] = [];
    const resolved = resolveTarget(scope);

    // Scope gate: fail closed before any network activity.
    assertTargetInScope(scope, resolved.host, resolved.httpPort);
    assertTargetInScope(scope, resolved.host, resolved.tlsPort);

    const applicable = this.registry.forTargetType(scope.target.targetType);
    if (applicable.length === 0) {
      throw new VaptError(
        ERROR_CODES.VAPT_ENGINE,
        `No registered checks support target type ${scope.target.targetType} for ${scope.target.value}.`,
      );
    }

    const checksExecuted: string[] = [];
    const checksSkipped: { checkId: string; reason: string }[] = [];
    const findings: VaptFinding[] = [];
    const evidence: EvidenceItem[] = [];
    const observedAt = this.now().toISOString();
    const target = findingTargetFromResolved(resolved, scope);

    for (const check of applicable) {
      if (signal?.aborted) {
        throw new VaptError(ERROR_CODES.VAPT_ENGINE, "VAPT scan cancelled");
      }
      const requirements = check.executionRequirements;
      if (requirements?.protocol && !requirements.protocol.includes(resolved.scheme)) {
        checksSkipped.push({
          checkId: check.checkId,
          reason: `requires protocol ${requirements.protocol.join("/")}`,
        });
        continue;
      }
      const ctx: CheckContext = {
        target,
        host: resolved.host,
        httpPort: resolved.httpPort,
        tlsPort: resolved.tlsPort,
        scheme: resolved.scheme,
        baseUrl: resolved.baseUrl,
        config,
        http: this.http,
        tls: this.tls,
      };
      let result: CheckResult;
      try {
        result = await check.run(ctx);
      } catch (err) {
        issues.push({
          code: ERROR_CODES.VAPT_CHECK,
          message: `Check ${check.checkId} failed: ${err instanceof Error ? err.message : String(err)}`,
          checkId: check.checkId,
        });
        continue;
      }
      if (result.skipped) {
        checksSkipped.push({ checkId: check.checkId, reason: result.skipped.reason });
        continue;
      }
      checksExecuted.push(check.checkId);
      for (const raw of result.findings) {
        const { finding, evidence: items } = normalizeFinding(raw, check, observedAt, VAPT_CLI_VERSION);
        findings.push(finding);
        evidence.push(...items);
      }
    }

    return {
      checksExecuted,
      checksSkipped,
      findings: deduplicateFindings(findings),
      evidence,
      durationMs: Date.now() - started,
      issues,
    };
  }
}
