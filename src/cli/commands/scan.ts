import type { Command } from "commander";
import { promises as fs } from "node:fs";
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

  const resolved = path.resolve(targetPath);
  let st;
  try {
    st = await fs.stat(resolved);
  } catch {
    throw new Error(
      `Scan path does not exist: ${resolved}\nScan the project folder, e.g.  dpdp scan .`,
    );
  }
  if (!st.isDirectory()) {
    throw new Error(`Scan path is not a directory: ${resolved}`);
  }

  console.log("Scanning (read-only):", resolved);
  const { bundle, issues } = await createDefaultScanner().scan(resolved);
  const findings = bundle.findings;
  console.log(`Found ${findings.length} DPDP evidence signals`);
  if (findings.length === 0) {
    console.log(
      "Nothing matched. Confirm this is the repo root (source, config, docs), not an empty or placeholder path.",
    );
  }

  // Non-fatal scan issues go to stderr; they never abort a scan.
  for (const issue of issues) {
    console.error(`scan warning: ${issue.message}`);
  }

  // Persist evidence + scan state locally FIRST so `evidence` and `submit`
  // work even if the backend is down.
  const state = await storage.scans.create({
    assessmentId: config.assessmentId,
    targetType: "MIXED",
    targetPath: resolved,
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
      targetPath: resolved,
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
