#!/usr/bin/env node
import { buildProgram } from "./cli/program.js";

// Thin bootstrap: build the CLI, parse argv, surface errors.
buildProgram().parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
