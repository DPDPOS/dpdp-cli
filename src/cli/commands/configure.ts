import type { Command } from "commander";
import { openStorage } from "../../storage/index.js";
import { requireConfig } from "./context.js";

export async function actionConfigure(opts: { assessment: string }): Promise<void> {
  const storage = await openStorage();
  const config = await requireConfig(storage);
  await storage.config.save({ ...config, assessmentId: opts.assessment });
  console.log("Configured assessment", opts.assessment);
}

export function registerConfigureCommand(program: Command): void {
  program
    .command("configure")
    .requiredOption("--assessment <id>", "Assessment UUID")
    .action(actionConfigure);
}
