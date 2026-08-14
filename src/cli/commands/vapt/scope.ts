import type { Command } from "commander";
import { openStorage } from "../../../storage/index.js";
import { requireConfig } from "../context.js";
import { parseScope } from "../../../vapt/scope/validate.js";
import type { VaptScope, VaptTargetType } from "../../../vapt/scope/types.js";

export type VaptScopeOptions = {
  target: string;
  targetType: string;
  include?: string[];
  exclude?: string[];
  port?: number[];
  profile?: string;
  mode?: string;
  authorizedBy: string;
  purpose: string;
  expires?: string;
};

export async function actionVaptScope(opts: VaptScopeOptions): Promise<void> {
  const storage = await openStorage();
  const config = await requireConfig(storage);
  if (!config.assessmentId) {
    throw new Error("Run dpdp configure --assessment <id> first");
  }

  const targetType = opts.targetType.toUpperCase() as VaptTargetType;
  const allowedPorts = (opts.port ?? []).map(Number);
  const scope: VaptScope = parseScope({
    target: { targetType, value: opts.target },
    includedTargets: (opts.include ?? []).map((v) => ({ targetType, value: v })),
    excludedTargets: (opts.exclude ?? []).map((v) => ({ targetType, value: v })),
    allowedPorts: allowedPorts.length > 0 ? allowedPorts : undefined,
    profile: opts.profile,
    mode: opts.mode,
    authorization: {
      authorizedBy: opts.authorizedBy,
      authorizedAt: new Date().toISOString(),
      purpose: opts.purpose,
      expiresAt: opts.expires,
    },
  });

  const existing = await storage.vaptConfig.load(config.assessmentId);
  const scopeVersion = (existing?.scopeVersion ?? 0) + 1;
  await storage.vaptConfig.save({
    assessmentId: config.assessmentId,
    scopeVersion,
    updatedAt: new Date().toISOString(),
    scope,
  });

  console.log(`VAPT scope saved for assessment ${config.assessmentId} (scope v${scopeVersion})`);
  console.log(`  target: ${scope.target.targetType} ${scope.target.value}`);
  if (scope.excludedTargets.length > 0) {
    console.log(`  excluded: ${scope.excludedTargets.map((t) => t.value).join(", ")}`);
  }
  if (scope.allowedPorts) {
    console.log(`  allowed ports: ${scope.allowedPorts.join(", ")}`);
  }
  console.log(`  profile: ${scope.profile}   mode: ${scope.mode}`);
  console.log("Next: dpdp vapt scan");
}

export function registerVaptScopeCommand(program: Command): void {
  program
    .command("scope")
    .description("Define or update the authorized VAPT scope for the configured assessment")
    .requiredOption("--target <value>", "Target (URL, hostname, IP, app/service id)")
    .requiredOption(
      "--target-type <type>",
      "Target type: URL | HOSTNAME | IP | APPLICATION | SERVICE",
    )
    .option("--include <target...>", "Additional authorized targets")
    .option("--exclude <target...>", "Excluded targets (never contacted)")
    .option("--port <port...>", "Allowed ports (engine refuses anything else)")
    .option("--profile <name>", "Scan profile", "web-baseline")
    .option("--mode <mode>", "Scan mode: passive | active-safe | active", "passive")
    .requiredOption("--authorized-by <who>", "Who authorized this assessment")
    .requiredOption("--purpose <text>", "Purpose of the assessment")
    .option("--expires <iso>", "Authorization expiry (ISO-8601)")
    .action(actionVaptScope);
}
