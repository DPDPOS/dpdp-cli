import type { Command } from "commander";
import { registerVaptScopeCommand } from "./scope.js";
import { registerVaptScanCommand } from "./scan.js";
import { registerVaptFindingsCommand } from "./findings.js";
import { registerVaptSubmitCommand } from "./submit.js";
import { registerVaptStatusCommand } from "./status.js";
import { registerVaptCancelCommand } from "./cancel.js";

/**
 * Assemble the `dpdp vapt` capability group. Each subcommand is thin and
 * delegates to application services; no engine logic lives here.
 */
export function registerVaptCommand(program: Command): void {
  const vapt = program
    .command("vapt")
    .description("VAPT capability (passive, authorized scope only)");

  registerVaptScopeCommand(vapt);
  registerVaptScanCommand(vapt);
  registerVaptFindingsCommand(vapt);
  registerVaptSubmitCommand(vapt);
  registerVaptStatusCommand(vapt);
  registerVaptCancelCommand(vapt);
}
