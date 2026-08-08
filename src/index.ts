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
  const json = (await res.json()) as {
    success?: boolean;
    data?: unknown;
    error?: unknown;
  };
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
    console.log(`Found ${findings.length} crypto/privacy evidence signals`);

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
      throw new Error("No local findings. Run dpdp scan <path> first.");
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
    console.log("Rescan is equivalent to scan + submit for the current assessment version.");
    console.log("Create a new assessment version in the UI/API before rescanning for history.");
    await program.parseAsync(["node", "dpdp", "scan", targetPath]);
    await program.parseAsync(["node", "dpdp", "submit"]);
  });

program
  .command("report")
  .description("Fetch assessment report (requires user JWT in DPDP_USER_TOKEN)")
  .action(async () => {
    const cfg = await loadConfig();
    const userToken = process.env.DPDP_USER_TOKEN;
    if (!userToken) {
      throw new Error("Set DPDP_USER_TOKEN to a user Bearer token to fetch reports");
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
    const json = await res.json();
    console.log(JSON.stringify(json, null, 2));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
