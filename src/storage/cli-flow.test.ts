import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import { actionConfigure } from "../cli/commands/configure.js";
import { actionEvidence } from "../cli/commands/evidence.js";
import { actionInit } from "../cli/commands/init.js";
import { actionLogin } from "../cli/commands/login.js";
import { actionReport } from "../cli/commands/report.js";
import { actionScan } from "../cli/commands/scan.js";
import { actionStatus } from "../cli/commands/status.js";
import { actionSubmit } from "../cli/commands/submit.js";
import { defaultStorageRoot, openStorage } from "./index.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/sample-app", import.meta.url));

type StubHandler = (
  url: string,
  init?: RequestInit,
) => { status?: number; data?: unknown } | never;

let originalFetch: typeof globalThis.fetch | undefined;
let originalUserToken: string | undefined;

function stubFetch(handler: StubHandler): void {
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const result = handler(u, init);
    const body = JSON.stringify({ success: true, data: result.data ?? {} });
    return new Response(body, {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function useTempHome(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dpdp-cli-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    return fs.rm(home, { recursive: true, force: true });
  });
  return home;
}

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
  if (originalUserToken === undefined) delete process.env.DPDP_USER_TOKEN;
  else process.env.DPDP_USER_TOKEN = originalUserToken;
  originalUserToken = undefined;
});

describe("CLI command flow (stubbed backend)", { concurrency: false }, () => {
  test("init → login → configure → scan → evidence → submit → status", async (t) => {
    await useTempHome(t);
    const calls: string[] = [];
    stubFetch((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/cli/scans") && init?.method === "POST") return { data: { id: "job-1" } };
      if (url.includes("/cli/evidence/batch")) return { data: { accepted: 14 } };
      if (url.includes("/cli/scans/job-1")) return { data: { status: "completed" } };
      return { status: 404 };
    });

    await actionInit();
    assert.ok((await fs.stat(defaultStorageRoot())).isDirectory());

    await actionLogin({ token: "dpdp_secret", api: "http://127.0.0.1:3000/" });
    await actionConfigure({ assessment: "assess-1" });

    const storage = await openStorage(defaultStorageRoot());
    assert.equal((await storage.config.load())?.apiBaseUrl, "http://127.0.0.1:3000");
    assert.equal((await storage.config.load())?.assessmentId, "assess-1");
    assert.equal((await storage.credentials.load())?.token, "dpdp_secret");

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    t.after(() => {
      console.log = originalLog;
    });

    await actionScan(FIXTURES);

    const current = await storage.scans.getCurrent();
    assert.ok(current);
    assert.equal(current.scanJobId, "job-1");
    assert.equal(current.status, "job_created");
    assert.equal(current.targetType, "MIXED");
    assert.ok(current.timestamps.scannedAt);
    const evidence = await storage.evidence.load(current.scanId);
    assert.equal(evidence?.findings.length, 14);

    await actionEvidence();
    assert.ok(logs.some((l) => l.includes("Total: 14")));

    await actionSubmit();
    const afterSubmit = await storage.scans.get(current.scanId);
    assert.equal(afterSubmit?.submission?.state, "submitted");
    assert.equal(afterSubmit?.status, "submitted");
    assert.ok(afterSubmit?.timestamps.submittedAt);

    await actionStatus();
    assert.ok(logs.some((l) => l.includes('"status": "completed"')));

    // Token must never appear in config/state/evidence files.
    const configRaw = await fs.readFile(
      path.join(defaultStorageRoot(), "config", "config.json"),
      "utf8",
    );
    const evidenceRaw = await fs.readFile(
      path.join(defaultStorageRoot(), "evidence", `${current.scanId}.json`),
      "utf8",
    );
    assert.ok(!configRaw.includes("dpdp_secret"));
    assert.ok(!evidenceRaw.includes("dpdp_secret"));
    assert.ok(calls.some((c) => c === "POST http://127.0.0.1:3000/api/v1/assessments/assess-1/cli/scans"));
    assert.ok(calls.some((c) => c === "POST http://127.0.0.1:3000/api/v1/assessments/assess-1/cli/evidence/batch"));
    assert.ok(calls.some((c) => c === "GET http://127.0.0.1:3000/api/v1/assessments/assess-1/cli/scans/job-1"));
  });

  test("failed submission preserves local evidence and allows retry", async (t) => {
    await useTempHome(t);
    stubFetch((url, init) => {
      if (url.includes("/cli/scans") && init?.method === "POST") return { data: { id: "job-2" } };
      return { status: 404 };
    });
    await actionLogin({ token: "dpdp_secret", api: "http://127.0.0.1:3000" });
    await actionConfigure({ assessment: "assess-2" });
    await actionScan(FIXTURES);

    // Backend goes down for the batch endpoint.
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    await assert.rejects(actionSubmit(), /network down/);

    const storage = await openStorage(defaultStorageRoot());
    const current = await storage.scans.getCurrent();
    assert.ok(current);
    assert.equal(current.submission?.state, "failed");
    const evidence = await storage.evidence.load(current.scanId);
    assert.equal(evidence?.findings.length, 14, "evidence must survive a failed submission");

    // Backend recovers; retry without rescanning.
    stubFetch((url, init) => {
      if (url.includes("/cli/evidence/batch")) return { data: { accepted: 14 } };
      return { status: 404 };
    });
    await actionSubmit();
    assert.equal((await storage.scans.get(current.scanId))?.submission?.state, "submitted");
  });

  test("multiple scans retain separate evidence artifacts", async (t) => {
    await useTempHome(t);
    let jobCounter = 0;
    stubFetch((url, init) => {
      if (url.includes("/cli/scans") && init?.method === "POST") {
        jobCounter += 1;
        return { data: { id: `job-${jobCounter}` } };
      }
      return { status: 404 };
    });
    await actionLogin({ token: "dpdp_secret", api: "http://127.0.0.1:3000" });
    await actionConfigure({ assessment: "assess-3" });

    await actionScan(FIXTURES);
    const storage = await openStorage(defaultStorageRoot());
    const first = (await storage.scans.getCurrent())!;

    await actionScan(FIXTURES);
    const second = (await storage.scans.getCurrent())!;

    assert.notEqual(first.scanId, second.scanId);
    assert.equal(first.scanJobId, "job-1");
    assert.equal(second.scanJobId, "job-2");
    assert.equal((await storage.scans.list()).length, 2);
    assert.equal((await storage.evidence.load(first.scanId))?.findings.length, 14);
    assert.equal((await storage.evidence.load(second.scanId))?.findings.length, 14);
  });

  test("existing CLI error messages are preserved", async (t) => {
    await useTempHome(t);
    await assert.rejects(actionSubmit(), /No local findings\/scan job. Run dpdp scan <path> first\./);
    await assert.rejects(actionStatus(), /No scan job yet/);
    await assert.rejects(actionConfigure({ assessment: "assess-x" }), /Run dpdp login/);

    await actionLogin({ token: "dpdp_secret", api: "http://127.0.0.1:3000" });
    await assert.rejects(actionScan(FIXTURES), /Run dpdp configure --assessment <id> first/);
    await actionConfigure({ assessment: "assess-x" });
    await assert.rejects(actionScan("./this-folder-does-not-exist"), /Scan path does not exist/);

    originalUserToken = process.env.DPDP_USER_TOKEN;
    delete process.env.DPDP_USER_TOKEN;
    await assert.rejects(actionReport(), /Prefer the frontend Assessments/);
  });

  test("evidence on a fresh install prints empty output instead of crashing", async (t) => {
    await useTempHome(t);
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    t.after(() => {
      console.log = originalLog;
    });
    await actionEvidence();
    assert.ok(logs.some((l) => l === "[]"));
    assert.ok(logs.some((l) => l === "Total: 0"));
  });

  // ------------------------------------------------------------------
  // aiContext submission tests
  // ------------------------------------------------------------------

  test("normal submission (no --ai) does not include aiContext", async (t) => {
    await useTempHome(t);
    let capturedPayload: Record<string, unknown> | undefined;
    stubFetch((url, init) => {
      if (url.includes("/cli/scans") && init?.method === "POST") return { data: { id: "job-ai-1" } };
      if (url.includes("/cli/evidence/batch")) {
        capturedPayload = JSON.parse(init?.body as string) as Record<string, unknown>;
        return { data: { accepted: 1 } };
      }
      return { status: 404 };
    });
    await actionLogin({ token: "dpdp_secret", api: "http://127.0.0.1:3000" });
    await actionConfigure({ assessment: "assess-ai-1" });
    await actionScan(FIXTURES);

    await actionSubmit();
    assert.ok(capturedPayload, "payload should have been captured");
    assert.deepEqual(capturedPayload!.findings, (await (await openStorage(defaultStorageRoot())).evidence.load((await (await openStorage(defaultStorageRoot())).scans.getCurrent())!.scanId))!.findings, "findings must be unchanged");
    assert.equal(capturedPayload!.aiContext, undefined, "aiContext must not be present without --ai");
    assert.equal(Object.prototype.hasOwnProperty.call(capturedPayload!, "aiContext"), false, "aiContext key must not exist in payload");
  });

  test("successful AI scan includes aiContext in submission payload", async (t) => {
    await useTempHome(t);
    let capturedPayload: Record<string, unknown> | undefined;
    stubFetch((url, init) => {
      if (url.includes("/cli/scans") && init?.method === "POST") return { data: { id: "job-ai-2" } };
      if (url.includes("/cli/evidence/batch")) {
        capturedPayload = JSON.parse(init?.body as string) as Record<string, unknown>;
        return { data: { accepted: 1 } };
      }
      return { status: 404 };
    });
    await actionLogin({ token: "dpdp_secret", api: "http://127.0.0.1:3000" });
    await actionConfigure({ assessment: "assess-ai-2" });
    await actionScan(FIXTURES);

    // Simulate what `scan --ai` stores: extra.aiContext on ScanState.
    const storage = await openStorage(defaultStorageRoot());
    const current = await storage.scans.getCurrent();
    assert.ok(current);
    const fakeAiContext = {
      classifiedAt: "2026-08-22T00:00:00.000Z",
      provider: "groq",
      model: "allam-2-7b",
      classifications: [
        {
          location: "src/a.ts:1",
          findingType: "consent_reference",
          classification: "positive_evidence",
          reasoning: "Consent collection implemented",
          confidence: 0.92,
        },
      ],
    };
    await storage.scans.update(current.scanId, { extra: { aiContext: fakeAiContext } });

    await actionSubmit();
    assert.ok(capturedPayload, "payload should have been captured");
    assert.deepEqual(capturedPayload!.aiContext, fakeAiContext, "aiContext must match ScanState.extra.aiContext exactly");
    assert.ok(Array.isArray(capturedPayload!.findings), "findings must still be present");
  });

  test("AI failure submits findings without aiContext", async (t) => {
    await useTempHome(t);
    let capturedPayload: Record<string, unknown> | undefined;
    stubFetch((url, init) => {
      if (url.includes("/cli/scans") && init?.method === "POST") return { data: { id: "job-ai-3" } };
      if (url.includes("/cli/evidence/batch")) {
        capturedPayload = JSON.parse(init?.body as string) as Record<string, unknown>;
        return { data: { accepted: 1 } };
      }
      return { status: 404 };
    });
    await actionLogin({ token: "dpdp_secret", api: "http://127.0.0.1:3000" });
    await actionConfigure({ assessment: "assess-ai-3" });
    await actionScan(FIXTURES);

    // Simulate scan --ai failure: extra has no aiContext (or it's absent).
    // No update to extra — scan without --ai leaves extra undefined.

    await actionSubmit();
    assert.ok(capturedPayload, "payload should have been captured");
    assert.equal(capturedPayload!.aiContext, undefined, "aiContext must not be present when AI fails");
    assert.equal(Object.prototype.hasOwnProperty.call(capturedPayload!, "aiContext"), false, "aiContext key must not exist in payload");
    // Findings must be structurally unchanged.
    const storage = await openStorage(defaultStorageRoot());
    const current = await storage.scans.getCurrent();
    const stored = await storage.evidence.load(current!.scanId);
    assert.deepEqual(capturedPayload!.findings, stored!.findings, "findings must be byte-for-byte identical");
  });

  test("aiContext payload matches ScanState.extra.aiContext exactly", async (t) => {
    await useTempHome(t);
    let capturedPayload: Record<string, unknown> | undefined;
    stubFetch((url, init) => {
      if (url.includes("/cli/scans") && init?.method === "POST") return { data: { id: "job-ai-4" } };
      if (url.includes("/cli/evidence/batch")) {
        capturedPayload = JSON.parse(init?.body as string) as Record<string, unknown>;
        return { data: { accepted: 1 } };
      }
      return { status: 404 };
    });
    await actionLogin({ token: "dpdp_secret", api: "http://127.0.0.1:3000" });
    await actionConfigure({ assessment: "assess-ai-4" });
    await actionScan(FIXTURES);

    const complexAiContext = {
      classifiedAt: "2026-08-22T12:34:56.789Z",
      provider: "groq",
      model: "mixtral-8x7b-32768",
      classifications: [
        {
          location: "src/a.ts:5",
          findingType: "consent_reference",
          classification: "reference_only",
          reasoning: "TODO comment",
          confidence: 0.6,
        },
        {
          location: "docs/privacy.md:10",
          findingType: "notice_language",
          classification: "positive_evidence",
          reasoning: "Privacy notice present",
          confidence: 0.95,
        },
      ],
    };

    const storage = await openStorage(defaultStorageRoot());
    const current = await storage.scans.getCurrent();
    assert.ok(current);
    await storage.scans.update(current.scanId, { extra: { aiContext: complexAiContext } });

    await actionSubmit();
    assert.ok(capturedPayload);
    assert.deepEqual(capturedPayload!.aiContext, complexAiContext, "payload aiContext must be structurally identical to ScanState.extra.aiContext");

    // Verify it's a deep equal, not just reference equality.
    const reserialized = JSON.parse(JSON.stringify(capturedPayload!.aiContext));
    assert.deepEqual(reserialized, complexAiContext, "re-serialized aiContext must match");
  });
});
