import type { Command } from "commander";
import { NodeHttpCollector } from "../../../vapt/collectors/http.js";
import { NodeTlsCollector } from "../../../vapt/collectors/tls.js";
import { VaptEngine } from "../../../vapt/engine/vapt-engine.js";
import { VAPT_EVIDENCE_SCHEMA_VERSION } from "../../../vapt/findings/types.js";
import { createDefaultVaptProfile } from "../../../vapt/profile/default.js";
import type { VaptScanConfig } from "../../../vapt/profile/types.js";
import { parseScope } from "../../../vapt/scope/validate.js";
import { openStorage } from "../../../storage/index.js";
import { requireConfig } from "../context.js";

export type VaptScanOptions = {
  mode?: string;
  profile?: string;
  timeoutMs?: number;
};

export async function actionVaptScan(opts: VaptScanOptions): Promise<void> {
  const storage = await openStorage();
  const config = await requireConfig(storage);
  if (!config.assessmentId) {
    throw new Error("Run dpdp configure --assessment <id> first");
  }

  const stored = await storage.vaptConfig.load(config.assessmentId);
  const scope = stored?.scope ? parseScope(stored.scope) : null;
  if (!scope) {
    throw new Error(
      `No VAPT scope configured for assessment ${config.assessmentId}. ` +
        "Run: dpdp vapt scope --target <url> --target-type URL --authorized-by <who> --purpose <why>",
    );
  }

  const profile = createDefaultVaptProfile();
  const mode = opts.mode ?? scope.mode ?? profile.config.mode;
  if (mode !== "passive") {
    throw new Error(
      "This build of the VAPT capability is passive-only. Configure the scope with --mode passive.",
    );
  }
  const scanConfig: VaptScanConfig = {
    ...profile.config,
    profile: opts.profile ?? scope.profile ?? profile.config.profile,
    mode,
    timeoutMs: opts.timeoutMs ?? profile.config.timeoutMs,
  };

  const engine = new VaptEngine({
    registry: profile.registry,
    http: new NodeHttpCollector(scanConfig.timeoutMs),
    tls: new NodeTlsCollector(scanConfig.timeoutMs),
  });

  const startedAt = new Date().toISOString();
  const state = await storage.scans.create({
    assessmentId: config.assessmentId,
    capability: "VAPT",
    status: "running",
    targetType: scope.target.targetType,
    targetPath: scope.target.value,
    extra: {
      scopeVersion: scope.scopeVersion,
      config: scanConfig,
      checks: { executed: [], skipped: [] },
      startedAt,
    },
  });

  console.log(
    `VAPT scan of ${scope.target.value} (profile ${scanConfig.profile}, ${scanConfig.mode}, scope v${scope.scopeVersion})`,
  );
  try {
    const summary = await engine.run(scope, scanConfig);
    for (const issue of summary.issues) {
      console.error(`vapt warning: ${issue.message}`);
    }
    await storage.evidence.save(state.scanId, {
      capability: "VAPT",
      schemaVersion: VAPT_EVIDENCE_SCHEMA_VERSION,
      vaptFindings: summary.findings,
      evidence: summary.evidence,
    });
    const completedAt = new Date().toISOString();
    await storage.scans.update(state.scanId, {
      status: "completed",
      extra: {
        scopeVersion: scope.scopeVersion,
        config: scanConfig,
        checks: { executed: summary.checksExecuted, skipped: summary.checksSkipped },
        startedAt,
        completedAt,
        durationMs: summary.durationMs,
        findingsCount: summary.findings.length,
      },
    });

    console.log(`Checks executed: ${summary.checksExecuted.length}, skipped: ${summary.checksSkipped.length}`);
    for (const skipped of summary.checksSkipped) {
      console.log(`  skipped: ${skipped.checkId} — ${skipped.reason}`);
    }
    for (const finding of summary.findings) {
      console.log(`  [${finding.severity}] ${finding.title} (${finding.checkId})`);
    }
    console.log(`Findings: ${summary.findings.length}`);
    console.log("Run: dpdp vapt findings   # preview local findings");
  } catch (err) {
    await storage.scans
      .update(state.scanId, {
        status: "failed",
        extra: {
          ...(state.extra ?? {}),
          error: err instanceof Error ? err.message : String(err),
        },
      })
      .catch(() => {});
    throw err;
  }
}

export function registerVaptScanCommand(program: Command): void {
  program
    .command("scan")
    .description("Run a passive VAPT scan against the authorized scope")
    .option("--mode <mode>", "Override scope mode (must be passive in this build)")
    .option("--profile <name>", "Override profile name")
    .option("--timeout-ms <ms>", "Per-request timeout in milliseconds", (v: string) => Number(v))
    .action(actionVaptScan);
}
