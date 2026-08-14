import type { Command } from "commander";
import { openStorage } from "../../storage/index.js";
import { api } from "../../transport/api.js";
import { requireConfig, requireToken } from "./context.js";

export async function actionStatus(): Promise<void> {
  const storage = await openStorage();
  const current = await storage.scans.getCurrent();
  if (!current?.scanJobId) throw new Error("No scan job yet");

  const config = await requireConfig(storage);
  const token = await requireToken(storage);
  const status = await api(
    config.apiBaseUrl,
    token,
    "GET",
    `/api/v1/assessments/${config.assessmentId}/cli/scans/${current.scanJobId}`,
  );
  console.log(JSON.stringify(status, null, 2));
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show last scan job status")
    .action(actionStatus);
}
