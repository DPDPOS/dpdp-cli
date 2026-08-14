import { Command } from "commander";
import { registerConfigureCommand } from "./commands/configure.js";
import { registerVaptCommand } from "./commands/vapt/vapt.js";
import { registerEvidenceCommand } from "./commands/evidence.js";
import { registerInitCommand } from "./commands/init.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerReportCommand } from "./commands/report.js";
import { registerRescanCommand } from "./commands/rescan.js";
import { registerScanCommand } from "./commands/scan.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSubmitCommand } from "./commands/submit.js";

/**
 * Assemble the full dpdp CLI. This layer only defines commands/options and
 * wires them to application services — no business logic, no scanner code.
 */
export function buildProgram(): Command {
  const program = new Command();
  program.name("dpdp").description("Read-only DPDP compliance scanner").version("0.1.0");

  registerInitCommand(program);
  registerLoginCommand(program);
  registerConfigureCommand(program);
  registerScanCommand(program);
  registerEvidenceCommand(program);
  registerSubmitCommand(program);
  registerStatusCommand(program);
  registerRescanCommand(program);
  registerReportCommand(program);
  registerVaptCommand(program);

  return program;
}
