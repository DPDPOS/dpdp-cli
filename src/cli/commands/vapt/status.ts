import type { Command } from "commander";
import { openStorage } from "../../../storage/index.js";
import { latestVaptScanId } from "../../../vapt/findings/evidence.js";

export type VaptStatusOptions = {
  scan?: string;
};

/**
 * Shows local VAPT scan state. Backend status polling requires a backend
 * VAPT API, which does not exist yet — the command reports the local state
 * and makes no requests.
 */
export async function actionVaptStatus(opts: VaptStatusOptions): Promise<void> {
  const storage = await openStorage();
  const scanId = opts.scan ?? (await latestVaptScanId(storage));
  if (!scanId) {
    throw new Error("No VAPT scans found. Run: dpdp vapt scan first.");
  }
  const state = await storage.scans.get(scanId);
  if (!state) throw new Error(`No scan state found for ${scanId}`);
  console.log("VAPT backend status polling is not connected yet (no backend VAPT API).");
  console.log(
    JSON.stringify(
      {
        scanId: state.scanId,
        status: state.status,
        ...(state.extra ?? {}),
      },
      null,
      2,
    ),
  );
}

export function registerVaptStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show VAPT scan state (backend polling not connected yet)")
    .option("--scan <id>", "Scan id to inspect")
    .action(actionVaptStatus);
}
