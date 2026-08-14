import type { Command } from "commander";
import { latestVaptScanId, loadVaptEvidence } from "../../../vapt/findings/evidence.js";
import { openStorage } from "../../../storage/index.js";

export type VaptFindingsOptions = {
  scan?: string;
};

export async function actionVaptFindings(opts: VaptFindingsOptions): Promise<void> {
  const storage = await openStorage();
  const scanId = opts.scan ?? (await latestVaptScanId(storage));
  if (!scanId) {
    console.log("[]");
    console.log("Total: 0");
    console.error("No VAPT scans found. Run: dpdp vapt scan");
    return;
  }
  const bundle = await loadVaptEvidence(storage, scanId);
  const findings = bundle?.vaptFindings ?? [];
  console.log(JSON.stringify(findings, null, 2));
  console.log(`Total: ${findings.length}`);
}

export function registerVaptFindingsCommand(program: Command): void {
  program
    .command("findings")
    .description("Show local VAPT findings (latest scan, or --scan <id>)")
    .option("--scan <id>", "Scan id to show")
    .action(actionVaptFindings);
}
