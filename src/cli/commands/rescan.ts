import type { Command } from "commander";
import { actionScan } from "./scan.js";
import { actionSubmit } from "./submit.js";

export async function actionRescan(targetPath: string): Promise<void> {
  console.log("Rescan = scan + submit for the current assessment version.");
  console.log(
    "For history: create a new version in the frontend Assessments → Overview tab first, then rescan.",
  );
  // Scan + submit directly (same code paths as the individual commands).
  await actionScan(targetPath);
  await actionSubmit();
}

export function registerRescanCommand(program: Command): void {
  program
    .command("rescan")
    .argument("<path>", "Directory to rescan")
    .action(actionRescan);
}
