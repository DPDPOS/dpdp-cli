import type { Command } from "commander";
import { openStorage } from "../../storage/index.js";
import { requireConfig } from "./context.js";

export async function actionReport(): Promise<void> {
  const storage = await openStorage();
  const config = await requireConfig(storage);
  const userToken = process.env.DPDP_USER_TOKEN;
  if (!userToken) {
    throw new Error(
      "Prefer the frontend Assessments → Results tab. Or set DPDP_USER_TOKEN to a user Bearer JWT.",
    );
  }
  const res = await fetch(
    `${config.apiBaseUrl}/api/v1/assessments/${config.assessmentId}/report`,
    {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: "application/json",
      },
    },
  );
  const text = await res.text();
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    throw new Error(`Report fetch failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

export function registerReportCommand(program: Command): void {
  program
    .command("report")
    .description("Fetch assessment report (optional; prefer frontend Results tab)")
    .action(actionReport);
}
