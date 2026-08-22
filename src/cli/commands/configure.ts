import type { Command } from "commander";
import { promises as fs } from "node:fs";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  buildGroqEnvVars,
  envFilePath,
  hasGroqKey,
  writeEnvFile,
} from "../../storage/env-file.js";
import { openStorage } from "../../storage/index.js";
import { requireConfig } from "./context.js";

// ---------------------------------------------------------------------------
// Hidden input helper
// ---------------------------------------------------------------------------

/**
 * Prompt the user for a line of input without echoing to the terminal.
 * Uses raw mode to suppress keystrokes, restoring the terminal state after.
 */
async function promptHidden(rl: readline.Interface, question: string): Promise<string> {
  // On Windows, raw mode may not suppress all output; on POSIX it works well.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    // Suppress echo by not writing to stdout
  }

  let answer: string;
  try {
    answer = (await rl.question(question)) ?? "";
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }
  return answer.trim();
}

/**
 * Ask a yes/no question.
 */
async function confirm(rl: readline.Interface, question: string): Promise<boolean> {
  const answer = (await rl.question(question + " [y/N] ")) ?? "";
  return answer.trim().toLowerCase() === "y";
}

// ---------------------------------------------------------------------------
// Core configure action
// ---------------------------------------------------------------------------

export type ConfigureOptions = {
  assessment?: string;
};

/**
 * `dpdp configure` — interactive setup for Groq AI credentials and assessment.
 *
 * Flow:
 * 1. If --assessment is provided, save it (existing behavior, then return).
 * 2. If no --assessment, prompt for Groq API key and manage .env.
 */
export async function actionConfigure(opts: ConfigureOptions = {}): Promise<void> {
  const rl = readline.createInterface({ input, output, terminal: true });

  try {
    // --- Assessment configuration (existing behavior) ---
    if (opts.assessment) {
      const storage = await openStorage();
      const config = await requireConfig(storage);
      await storage.config.save({ ...config, assessmentId: opts.assessment });
      console.log("Configured assessment:", opts.assessment);
      return; // --assessment mode: skip Groq prompt
    }

    // --- Groq AI configuration (default when no --assessment) ---
    const projectRoot = process.cwd();
    const dotEnvPath = envFilePath(projectRoot);
    const existingContent = (await fs.readFile(dotEnvPath, "utf8").catch(() => null));
    const existingVars = existingContent
      ? (await import("../../storage/env-file.js")).parseEnvFile(existingContent)
      : null;

    const hasExistingKey = existingVars ? hasGroqKey(existingVars) : false;

    if (hasExistingKey) {
      const overwrite = await confirm(
        rl,
        "Groq API key is already configured. Overwrite? ",
      );
      if (!overwrite) {
        console.log("Keeping existing Groq configuration.");
        return;
      }
    }

    // Prompt for the new key (hidden input)
    const apiKey = await promptHidden(rl, "Enter Groq API key: ");
    if (!apiKey) {
      console.error("No API key entered. Groq configuration cancelled.");
      return;
    }

    // Build the Groq env vars to write
    const groqVars = buildGroqEnvVars(apiKey);

    // Write .env, preserving existing non-GROQ variables
    await writeEnvFile(dotEnvPath, existingContent, groqVars);

    // Set restrictive permissions (already done by writeEnvFile, but ensure)
    try {
      await fs.chmod(dotEnvPath, 0o600);
    } catch {
      // Ignore on platforms without permission support
    }

    console.log("✓ Groq AI configured");
    console.log(`  Saved to ${dotEnvPath}`);
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerConfigureCommand(program: Command): void {
  program
    .command("configure")
    .description(
      "Configure the CLI: Groq AI credentials and assessment ID",
    )
    .option("--assessment <id>", "Assessment UUID to configure")
    .action(actionConfigure);
}
