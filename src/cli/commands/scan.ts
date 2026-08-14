import type { Command } from "commander";
import path from "node:path";
import { createDefaultScanner } from "../../core/profiles/default.js";
import { openStorage } from "../../storage/index.js";
import { api } from "../../transport/api.js";
import { requireConfig, requireToken } from "./context.js";

export async function actionScan(targetPath: string): Promise<void> {
  const storage = await openStorage();
  const config = await requireConfig(storage);
  if (!config.assessmentId) {
    throw new Error("Run dpdp configure --assessment <id> first");
  }

  console.log("Scanning (read-only):", path.resolve(targetPath));
  const { bundle, issues } = await createDefaultScanner().scan(targetPath);
  const findings = bundle.findings;
  console.log(`Found ${findings.length} DPDP evidence signals`);

  // Non-fatal scan issues go to stderr; they never abort a scan.
  for (const issue of issues) {
    console.error(`scan warning: ${issue.message}`);
  }

  // Persist evidence + scan state locally FIRST so `evidence` and `submit`
  // work even if the backend is down.
  const state = await storage.scans.create({
    assessmentId: config.assessmentId,
    targetType: "MIXED",
    targetPath: path.resolve(targetPath),
  });
  await storage.evidence.save(state.scanId, bundle);
  await storage.scans.setCurrentScanId(state.scanId);

  const token = await requireToken(storage);
  const job = (await api(
    config.apiBaseUrl,
    token,
    "POST",
    `/api/v1/assessments/${config.assessmentId}/cli/scans`,
    {
      targetType: "MIXED",
      targetPath: path.resolve(targetPath),
      cliVersion: "0.1.0",
    },
  )) as { id: string };

  await storage.scans.update(state.scanId, { scanJobId: job.id, status: "job_created" });

  console.log("Scan job:", job.id);
  console.log("Run: dpdp evidence   # preview");
  console.log("Then: dpdp submit");
}

export function registerScanCommand(program: Command): void {
  program
    .command("scan")
    .argument("<path>", "Directory to scan (read-only)")
    .action(actionScan);
}
