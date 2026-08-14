import type { Command } from "commander";

/**
 * Cancellation of an in-flight VAPT scan is not available in this build:
 * scans run synchronously to completion in a single process, so there is no
 * second process to signal. The engine accepts an AbortSignal for future
 * out-of-process cancellation. No fake functionality is offered.
 */
export async function actionVaptCancel(): Promise<void> {
  console.log(
    "VAPT cancellation is not available yet: scans run to completion in a single process.",
  );
}

export function registerVaptCancelCommand(program: Command): void {
  program
    .command("cancel")
    .description("Cancel a running VAPT scan (not available in this build)")
    .action(actionVaptCancel);
}
