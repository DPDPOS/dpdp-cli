import type { Command } from "commander";
import { openStorage } from "../../../storage/index.js";
import { latestVaptScanId, loadVaptEvidence } from "../../../vapt/findings/evidence.js";
import { buildVaptSubmissionPayload } from "../../../vapt/transport/submission.js";
import { requireConfig } from "../context.js";

export type VaptSubmitOptions = {
  scan?: string;
};

/**
 * The backend has no VAPT API yet. Rather than making fake requests, this
 * command validates the local state and prints the exact typed payload the
 * future backend will receive (Phase 3 design, docs/vapt/06).
 */
export async function actionVaptSubmit(opts: VaptSubmitOptions): Promise<void> {
  const storage = await openStorage();
  const scanId = opts.scan ?? (await latestVaptScanId(storage));
  if (!scanId) {
    throw new Error("No VAPT scans found. Run: dpdp vapt scan first.");
  }
  const state = await storage.scans.get(scanId);
  const bundle = await loadVaptEvidence(storage, scanId);
  if (!state) throw new Error(`No scan state found for ${scanId}`);
  if (!bundle) throw new Error(`No VAPT evidence found for ${scanId}. Run: dpdp vapt scan`);

  const config = await requireConfig(storage);
  const payload = buildVaptSubmissionPayload({
    config,
    state,
    findings: bundle.vaptFindings,
    evidence: bundle.evidence,
  });

  console.log("VAPT backend submission is not connected yet (no backend VAPT API).");
  console.log("Payload that will be submitted once connected:");
  console.log(JSON.stringify(payload, null, 2));
}

export function registerVaptSubmitCommand(program: Command): void {
  program
    .command("submit")
    .description("Submit VAPT findings to the backend (not yet connected)")
    .option("--scan <id>", "Scan id to submit")
    .action(actionVaptSubmit);
}
