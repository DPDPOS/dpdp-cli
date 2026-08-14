import assert from "node:assert/strict";
import { promises as fs, mkdirSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, test } from "node:test";
import { actionConfigure } from "./commands/configure.js";
import { actionLogin } from "./commands/login.js";
import { actionVaptFindings } from "./commands/vapt/findings.js";
import { actionVaptScope } from "./commands/vapt/scope.js";
import { actionVaptScan } from "./commands/vapt/scan.js";
import { actionVaptSubmit } from "./commands/vapt/submit.js";
import { actionVaptStatus } from "./commands/vapt/status.js";
import { actionVaptCancel } from "./commands/vapt/cancel.js";
import { openStorage, defaultStorageRoot } from "../storage/index.js";

let originalHome: string | undefined;

function useTempHome(t: { after: (fn: () => unknown) => void }): string {
  const home = path.join(os.tmpdir(), `dpdp-vapt-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  return home;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  originalHome = undefined;
});

function startLocalServer(t: { after: (fn: () => unknown) => void }): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
      res.setHeader("Set-Cookie", "session=secret12345"); // must never be persisted
      res.end("ok");
    });
    server.on("clientError", (_err, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      t.after(() => new Promise<void>((done) => server.close(() => done())));
      resolve(port);
    });
  });
}

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ logs: string[]; result: T }> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    const result = await fn();
    return { logs, result };
  } finally {
    console.log = original;
  }
}

async function setup(t: { after: (fn: () => unknown) => void }): Promise<number> {
  useTempHome(t);
  await actionLogin({ token: "dpdp_secret", api: "http://127.0.0.1:3000" });
  await actionConfigure({ assessment: "assess-vapt" });
  return startLocalServer(t);
}

describe("dpdp vapt commands (local target)", () => {
  test("scope → scan → findings end to end", async (t) => {
    const port = await setup(t);
    const target = `http://127.0.0.1:${port}`;

    await actionVaptScope({
      target,
      targetType: "URL",
      authorizedBy: "tester@corp",
      purpose: "pre-release assessment",
    });

    const storage = await openStorage(defaultStorageRoot());
    const stored = await storage.vaptConfig.load("assess-vapt");
    assert.ok(stored, "scope must be persisted");
    assert.equal(stored.scopeVersion, 1);

    const { logs, result: _unused } = await captureLogs(() => actionVaptScan({}));
    assert.ok(logs.some((l) => l.includes("VAPT scan of")), "scan summary printed");
    assert.ok(logs.some((l) => l.includes("Findings: 2")), `expected 2 findings, got: ${logs.join(" | ")}`);

    // Scan state: VAPT capability, completed, local-first.
    const scans = (await storage.scans.list()).filter((s) => s.capability === "VAPT");
    assert.equal(scans.length, 1);
    const state = scans[0]!;
    assert.equal(state.status, "completed");
    assert.equal(state.targetPath, target);
    assert.equal((state.extra as { findingsCount?: number }).findingsCount, 2);

    // Evidence envelope: capability + schemaVersion 2 + VAPT findings.
    const evidence = await storage.evidence.load(state.scanId);
    assert.equal(evidence?.capability, "VAPT");
    assert.equal(evidence?.schemaVersion, 2);
    assert.equal(evidence?.vaptFindings?.length, 2);
    const titles = evidence?.vaptFindings?.map((f) => f.title) ?? [];
    assert.ok(titles.includes("HTTPS not available"));
    assert.ok(titles.includes("Security headers missing"));
    const httpsFinding = evidence!.vaptFindings!.find((f) => f.title === "HTTPS not available")!;
    assert.equal(httpsFinding.severity, "MEDIUM");
    assert.equal(httpsFinding.provenance.scanner, "dpdp-cli");
    assert.equal(httpsFinding.provenance.source, "local-check");
    const headersFinding = evidence!.vaptFindings!.find((f) => f.title === "Security headers missing")!;
    assert.equal(headersFinding.severity, "LOW");
    assert.match(headersFinding.description, /Content-Security-Policy/);

    // Evidence items are structured, not plain strings.
    assert.ok(evidence!.evidence!.length >= 2);
    assert.ok(evidence!.evidence!.every((e) => typeof e.evidenceId === "string" && e.kind.length > 0));

    // DPDP current-scan pointer must remain untouched (VAPT is isolated).
    assert.equal(await storage.scans.getCurrentScanId(), null);

    // Secrets never land in storage.
    const evidenceRaw = await fs.readFile(
      path.join(defaultStorageRoot(), "evidence", `${state.scanId}.json`),
      "utf8",
    );
    assert.ok(!evidenceRaw.includes("secret12345"), "Set-Cookie value leaked into evidence");

    // findings command prints the local preview.
    const findingsOut = await captureLogs(() => actionVaptFindings({}));
    assert.ok(findingsOut.logs.some((l) => l === "Total: 2"));

    // submit/status/cancel are honest about the missing backend.
    const submitOut = await captureLogs(() => actionVaptSubmit({}));
    assert.ok(submitOut.logs.some((l) => l.includes("not connected yet")));
    assert.ok(submitOut.logs.some((l) => l.includes('"assessmentId": "assess-vapt"')));
    const statusOut = await captureLogs(() => actionVaptStatus({}));
    assert.ok(statusOut.logs.some((l) => l.includes("not connected yet")));
    const cancelOut = await captureLogs(() => actionVaptCancel());
    assert.ok(cancelOut.logs.some((l) => l.includes("not available yet")));
  });

  test("scan fails closed without a scope", async (t) => {
    useTempHome(t);
    await actionLogin({ token: "dpdp_secret", api: "http://127.0.0.1:3000" });
    await actionConfigure({ assessment: "assess-vapt" });
    await assert.rejects(actionVaptScan({}), /No VAPT scope configured/);
  });

  test("invalid scope input is rejected with a clear error", async (t) => {
    useTempHome(t);
    await actionLogin({ token: "dpdp_secret", api: "http://127.0.0.1:3000" });
    await actionConfigure({ assessment: "assess-vapt" });
    await assert.rejects(
      actionVaptScope({ target: "not a url", targetType: "URL", authorizedBy: "x", purpose: "y" }),
      /not a valid URL/,
    );
    await assert.rejects(
      actionVaptScope({ target: "http://ok.example.com", targetType: "URL", authorizedBy: "x", purpose: "y", port: [99999] }),
      /port must be an integer/,
    );
  });

  test("non-passive mode is refused in this build", async (t) => {
    const port = await setup(t);
    await actionVaptScope({
      target: `http://127.0.0.1:${port}`,
      targetType: "URL",
      mode: "active",
      authorizedBy: "x",
      purpose: "y",
    });
    await assert.rejects(actionVaptScan({}), /passive-only/);
  });

  test("evidence command without scans prints empty output", async (t) => {
    useTempHome(t);
    await actionLogin({ token: "dpdp_secret", api: "http://127.0.0.1:3000" });
    await actionConfigure({ assessment: "assess-vapt" });
    const { logs } = await captureLogs(() => actionVaptFindings({}));
    assert.ok(logs.some((l) => l === "[]"));
    assert.ok(logs.some((l) => l === "Total: 0"));
  });
});
