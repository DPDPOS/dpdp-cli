import type { Command } from "commander";
import { storagePaths } from "../../storage/fs-utils.js";
import { defaultStorageRoot, openStorage } from "../../storage/index.js";

export async function actionLogin(opts: { token: string; api: string }): Promise<void> {
  if (!opts.token.startsWith("dpdp_")) {
    console.warn("Warning: CLI tokens from the platform usually start with dpdp_");
  }
  const apiBaseUrl = opts.api.replace(/\/$/, "");
  const storage = await openStorage();
  const existing = await storage.config.load();
  await storage.credentials.save({ token: opts.token });
  await storage.config.save({
    apiBaseUrl,
    assessmentId: existing?.assessmentId ?? "",
  });
  console.log("Logged in. Config saved to", storagePaths(defaultStorageRoot()).config);
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .requiredOption("--token <token>", "CLI token from the platform")
    .option("--api <url>", "API base URL", "http://127.0.0.1:3000")
    .action(actionLogin);
}
