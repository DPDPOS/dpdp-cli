#!/usr/bin/env node
import { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanDirectory, type Finding } from "./scanner.js";

type CliConfig = {
  apiBaseUrl: string;
  token: string;
  assessmentId: string;
  lastScanJobId?: string;
  lastFindings?: Finding[];
};

const CONFIG_PATH = path.join(os.homedir(), ".dpdp", "config.json");

async function loadConfig(): Promise<CliConfig> {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  return JSON.parse(raw) as CliConfig;
}

async function saveConfig(cfg: CliConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

async function api(
  cfg: CliConfig,
  method: string,
  apiPath: string,
  body?: unknown,
) {
  const res = await fetch(`${cfg.apiBaseUrl}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: { success?: boolean; data?: unknown; error?: unknown } = {};
  try {
    json = text ? (JSON.parse(text) as typeof json) : {};
  } catch {
    throw new Error(
      `API ${method} ${apiPath} returned non-JSON (${res.status}). ` +
        `Is the backend assessment spine running at ${cfg.apiBaseUrl}? ` +
        `Body starts with: ${text.slice(0, 80).replace(/\s+/g, " ")}`,
    );
  }

  if (!res.ok || json.success === false) {
    throw new Error(
      `API ${method} ${apiPath} failed (${res.status}): ${JSON.stringify(json.error ?? json)}`,
    );
  }
  return json.data;
}

const program = new Command();
program.name("dpdp").description("Read-only DPDP compliance scanner").version("0.1.0");

program
  .command("init")
  .description("Create local CLI config directory")
  .action(async () => {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    console.log(`Initialized ${path.dirname(CONFIG_PATH)}`);
    console.log("Next: dpdp login --token <token> --api <baseUrl>");
  });

program
  .command("login")
  .requiredOption("--token <token>", "CLI token from the platform")
  .option("--api <url>", "API base URL", "http://127.0.0.1:3000")
  .action(async (opts: { token: string; api: string }) => {
    if (!opts.token.startsWith("dpdp_")) {
      console.warn("Warning: CLI tokens from the platform usually start with dpdp_");
    }
    const apiBaseUrl = opts.api.replace(/\/$/, "");
    let cfg: CliConfig = {
      apiBaseUrl,
      token: opts.token,
      assessmentId: "",
    };
    try {
      const existing = await loadConfig();
      cfg = { ...existing, apiBaseUrl, token: opts.token };
    } catch {
      // first login
    }
    await saveConfig(cfg);
    console.log("Logged in. Config saved to", CONFIG_PATH);
  });

program
  .command("configure")
  .requiredOption("--assessment <id>", "Assessment UUID")
  .action(async (opts: { assessment: string }) => {
    const cfg = await loadConfig();
    cfg.assessmentId = opts.assessment;
    await saveConfig(cfg);
    console.log("Configured assessment", opts.assessment);
  });

program
  .command("scan")
  .argument("<path>", "Directory to scan (read-only)")
  .action(async (targetPath: string) => {
    const cfg = await loadConfig();
    if (!cfg.assessmentId) {
      throw new Error("Run dpdp configure --assessment <id> first");
    }

    console.log("Scanning (read-only):", path.resolve(targetPath));
    const findings = await scanDirectory(targetPath);
    console.log(`Found ${findings.length} DPDP evidence signals`);

    // Persist locally first so `evidence` works even if API is down.
    cfg.lastFindings = findings;
    await saveConfig(cfg);

    const job = (await api(cfg, "POST", `/api/v1/assessments/${cfg.assessmentId}/cli/scans`, {
      targetType: "MIXED",
      targetPath: path.resolve(targetPath),
      cliVersion: "0.1.0",
    })) as { id: string };

    cfg.lastScanJobId = job.id;
    cfg.lastFindings = findings;
    await saveConfig(cfg);

    console.log("Scan job:", job.id);
    console.log("Run: dpdp evidence   # preview");
    console.log("Then: dpdp submit");
  });

program
  .command("evidence")
  .description("Show last local scan findings")
  .action(async () => {
    const cfg = await loadConfig();
    const findings = cfg.lastFindings ?? [];
    console.log(JSON.stringify(findings, null, 2));
    console.log(`Total: ${findings.length}`);
  });

program
  .command("submit")
  .description("Submit last findings to the platform")
  .action(async () => {
    const cfg = await loadConfig();
    if (!cfg.lastScanJobId || !cfg.lastFindings?.length) {
      throw new Error("No local findings/scan job. Run dpdp scan <path> first.");
    }
    const result = await api(
      cfg,
      "POST",
      `/api/v1/assessments/${cfg.assessmentId}/cli/evidence/batch`,
      {
        scanJobId: cfg.lastScanJobId,
        findings: cfg.lastFindings,
      },
    );
    console.log("Submitted:", JSON.stringify(result, null, 2));
  });

program
  .command("status")
  .description("Show last scan job status")
  .action(async () => {
    const cfg = await loadConfig();
    if (!cfg.lastScanJobId) throw new Error("No scan job yet");
    const status = await api(
      cfg,
      "GET",
      `/api/v1/assessments/${cfg.assessmentId}/cli/scans/${cfg.lastScanJobId}`,
    );
    console.log(JSON.stringify(status, null, 2));
  });

program
  .command("rescan")
  .argument("<path>", "Directory to rescan")
  .action(async (targetPath: string) => {
    console.log("Rescan = scan + submit for the current assessment version.");
    console.log(
      "For history: create a new version in the frontend Assessments → Overview tab first, then rescan.",
    );
    await program.parseAsync(["node", "dpdp", "scan", targetPath], { from: "user" });
    await program.parseAsync(["node", "dpdp", "submit"], { from: "user" });
  });

program
  .command("report")
  .description("Fetch assessment report (optional; prefer frontend Results tab)")
  .action(async () => {
    const cfg = await loadConfig();
    const userToken = process.env.DPDP_USER_TOKEN;
    if (!userToken) {
      throw new Error(
        "Prefer the frontend Assessments → Results tab. Or set DPDP_USER_TOKEN to a user Bearer JWT.",
      );
    }
    const res = await fetch(
      `${cfg.apiBaseUrl}/api/v1/assessments/${cfg.assessmentId}/report`,
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
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
