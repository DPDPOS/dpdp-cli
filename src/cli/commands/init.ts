import type { Command } from "commander";
import { defaultStorageRoot, openStorage } from "../../storage/index.js";

export async function actionInit(): Promise<void> {
  await openStorage();
  console.log(`Initialized ${defaultStorageRoot()}`);
  console.log("Next: dpdp login --token <token> --api <baseUrl>");
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Create local CLI config directory")
    .action(actionInit);
}
