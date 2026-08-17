import type { Command } from "commander";
import { openStorage } from "../../storage/index.js";
import { api } from "../../transport/api.js";
import { requireConfig, requireToken } from "./context.js";

export async function actionSubmit(): Promise<void> {
  const storage = await openStorage();
  const current = await storage.scans.getCurrent();
  if (!current?.scanJobId) {
    throw new Error("No local findings/scan job. Run dpdp scan <path> first.");
  }
  const stored = await storage.evidence.load(current.scanId);
  if (!stored?.findings.length) {
    throw new Error(
      "Last scan found 0 DPDP signals, so there is nothing to submit. Scan the project root:  dpdp scan .",
    );
  }

  const config = await requireConfig(storage);
  const token = await requireToken(storage);

  try {
    const result = await api(
      config.apiBaseUrl,
      token,
      "POST",
      `/api/v1/assessments/${config.assessmentId}/cli/evidence/batch`,
      {
        scanJobId: current.scanJobId,
        findings: stored.findings,
      },
    );
    const submittedAt = new Date().toISOString();
    await storage.scans.update(current.scanId, {
      status: "submitted",
      timestamps: { submittedAt },
      submission: { state: "submitted", submittedAt },
    });
    console.log("Submitted:", JSON.stringify(result, null, 2));
  } catch (err) {
    // Record the failure; the local evidence is left intact so the user can
    // retry `dpdp submit` without rescanning.
    await storage.scans
      .update(current.scanId, {
        submission: {
          state: "failed",
          submittedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        },
      })
      .catch(() => {});
    throw err;
  }
}

export function registerSubmitCommand(program: Command): void {
  program
    .command("submit")
    .description("Submit last findings to the platform")
    .action(actionSubmit);
}
