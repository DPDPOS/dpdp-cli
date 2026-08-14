import type { Command } from "commander";
import { openStorage } from "../../storage/index.js";

export async function actionEvidence(): Promise<void> {
  const storage = await openStorage();
  const current = await storage.scans.getCurrent();
  const findings = current
    ? ((await storage.evidence.load(current.scanId))?.findings ?? [])
    : [];
  console.log(JSON.stringify(findings, null, 2));
  console.log(`Total: ${findings.length}`);
}

export function registerEvidenceCommand(program: Command): void {
  program
    .command("evidence")
    .description("Show last local scan findings")
    .action(actionEvidence);
}
