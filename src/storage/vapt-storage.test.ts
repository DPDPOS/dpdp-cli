import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { VAPT_EVIDENCE_SCHEMA_VERSION, type EvidenceItem, type VaptFinding } from "../vapt/findings/types.js";
import { openStorage } from "./index.js";

async function makeRoot(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpdp-vapt-storage-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const SCOPE = {
  scopeVersion: 1,
  target: { targetType: "URL", value: "https://app.example.com", hostname: "app.example.com", protocol: "https" },
  includedTargets: [],
  excludedTargets: [],
  allowedPorts: [443],
  profile: "web-baseline",
  mode: "passive",
  authorization: { authorizedBy: "tester", authorizedAt: "2026-01-01T00:00:00.000Z", purpose: "test" },
};

function vaptFinding(overrides: Partial<VaptFinding> = {}): VaptFinding {
  return {
    findingId: "finding-1",
    checkId: "tls/https-availability",
    category: "tls",
    severity: "MEDIUM",
    title: "HTTPS not available",
    target: { targetType: "URL", hostname: "app.example.com", port: 443, protocol: "https" },
    description: "no tls",
    evidenceRefs: ["ev-1"],
    observedAt: "2026-01-01T00:00:00.000Z",
    provenance: {
      scanner: "dpdp-cli",
      scannerVersion: "0.1.0",
      checkId: "tls/https-availability",
      checkVersion: "1.0.0",
      source: "local-check",
    },
    ...overrides,
  };
}

const EVIDENCE: EvidenceItem = {
  evidenceId: "ev-1",
  findingId: "finding-1",
  kind: "tls",
  observedValue: "TLS handshake failed: ECONNREFUSED",
  capturedAt: "2026-01-01T00:00:00.000Z",
};

describe("VaptConfigStore", () => {
  test("persists and reloads a per-assessment scope", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    assert.equal(await storage.vaptConfig.load("assess-1"), null);
    await storage.vaptConfig.save({
      assessmentId: "assess-1",
      scopeVersion: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      scope: SCOPE,
    });
    const loaded = await storage.vaptConfig.load("assess-1");
    assert.equal(loaded?.assessmentId, "assess-1");
    assert.equal(loaded?.scopeVersion, 1);
    assert.deepEqual(loaded?.scope, SCOPE);
    // Different assessment ids are independent.
    assert.equal(await storage.vaptConfig.load("assess-2"), null);
  });

  test("unsafe assessment ids are rejected before path use", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    await assert.rejects(storage.vaptConfig.save({ assessmentId: "../evil", scopeVersion: 1, updatedAt: "t", scope: SCOPE }), /Unsafe/);
    await assert.rejects(storage.vaptConfig.load("../evil"), /Unsafe/);
  });

  test("corrupt vapt config reports a clear error", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    await fs.mkdir(path.join(root, "config", "vapt"), { recursive: true });
    await fs.writeFile(path.join(root, "config", "vapt", "assess-1.json"), "not json");
    await assert.rejects(storage.vaptConfig.load("assess-1"), /Corrupt JSON/);
  });
});

describe("scan state capability tagging", () => {
  test("VAPT scans carry capability + extra; DPDP scans do not", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);

    const vapt = await storage.scans.create({
      assessmentId: "assess-1",
      capability: "VAPT",
      status: "running",
      extra: { scopeVersion: 1, checks: { executed: [], skipped: [] } },
    });
    assert.equal(vapt.capability, "VAPT");
    assert.equal(vapt.status, "running");
    assert.equal(vapt.extra?.scopeVersion, 1);
    const reloaded = await storage.scans.get(vapt.scanId);
    assert.equal(reloaded?.capability, "VAPT");
    assert.deepEqual(reloaded?.extra, { scopeVersion: 1, checks: { executed: [], skipped: [] } });

    const dpdp = await storage.scans.create({ assessmentId: "assess-1" });
    assert.equal(dpdp.capability, undefined);
    assert.equal(dpdp.status, "scanned");
    const dpdpReloaded = await storage.scans.get(dpdp.scanId);
    assert.equal(dpdpReloaded?.capability, undefined);

    const raw = await fs.readFile(path.join(root, "state", "scans", `${dpdp.scanId}.json`), "utf8");
    assert.ok(!raw.includes("capability"), "DPDP scan state must not gain a capability field");
  });

  test("update preserves capability and replaces extra", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    const state = await storage.scans.create({
      assessmentId: "assess-1",
      capability: "VAPT",
      status: "running",
      extra: { checks: { executed: [], skipped: [] } },
    });
    await storage.scans.update(state.scanId, {
      status: "completed",
      extra: { checks: { executed: ["a"], skipped: [] }, findingsCount: 2 },
    });
    const updated = await storage.scans.get(state.scanId);
    assert.equal(updated?.status, "completed");
    assert.equal(updated?.capability, "VAPT");
    assert.deepEqual(updated?.extra, { checks: { executed: ["a"], skipped: [] }, findingsCount: 2 });
  });
});

describe("VAPT evidence envelope", () => {
  test("VAPT evidence is saved with capability + schemaVersion 2 and loads back", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    await storage.evidence.save("scan-vapt", {
      capability: "VAPT",
      schemaVersion: VAPT_EVIDENCE_SCHEMA_VERSION,
      vaptFindings: [vaptFinding()],
      evidence: [EVIDENCE],
    });
    const loaded = await storage.evidence.load("scan-vapt");
    assert.equal(loaded?.capability, "VAPT");
    assert.equal(loaded?.schemaVersion, VAPT_EVIDENCE_SCHEMA_VERSION);
    assert.equal(loaded?.vaptFindings?.length, 1);
    assert.equal(loaded?.evidence?.length, 1);
    assert.deepEqual(loaded?.vaptFindings, [vaptFinding()]);
    // The DPDP findings field stays empty for VAPT artifacts.
    assert.deepEqual(loaded?.findings, []);
  });

  test("DPDP evidence still loads with the old shape", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    await storage.evidence.save("scan-dpdp", {
      schemaVersion: 1,
      findings: [{ sourceType: "CODE", location: "a.ts:1", findingType: "consent", confidence: 0.85, controlCandidates: [] }],
    });
    const loaded = await storage.evidence.load("scan-dpdp");
    assert.equal(loaded?.capability, undefined);
    assert.equal(loaded?.schemaVersion, 1);
    assert.equal(loaded?.findings.length, 1);
    assert.equal(loaded?.vaptFindings, undefined);
  });

  test("multiple VAPT scans keep separate artifacts", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    const a = await storage.scans.create({ assessmentId: "a1", capability: "VAPT", status: "running" });
    const b = await storage.scans.create({ assessmentId: "a1", capability: "VAPT", status: "running" });
    await storage.evidence.save(a.scanId, {
      capability: "VAPT",
      schemaVersion: VAPT_EVIDENCE_SCHEMA_VERSION,
      vaptFindings: [vaptFinding({ findingId: "fa" })],
      evidence: [],
    });
    await storage.evidence.save(b.scanId, {
      capability: "VAPT",
      schemaVersion: VAPT_EVIDENCE_SCHEMA_VERSION,
      vaptFindings: [vaptFinding({ findingId: "fb" })],
      evidence: [],
    });
    assert.equal((await storage.evidence.load(a.scanId))?.vaptFindings?.[0]?.findingId, "fa");
    assert.equal((await storage.evidence.load(b.scanId))?.vaptFindings?.[0]?.findingId, "fb");
    assert.equal((await storage.scans.list()).length, 2);
  });

  test("evidence survives a failed scan state (local-first)", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    const state = await storage.scans.create({ assessmentId: "a1", capability: "VAPT", status: "running" });
    await storage.evidence.save(state.scanId, {
      capability: "VAPT",
      schemaVersion: VAPT_EVIDENCE_SCHEMA_VERSION,
      vaptFindings: [vaptFinding()],
      evidence: [EVIDENCE],
    });
    await storage.scans.update(state.scanId, { status: "failed", extra: { error: "boom" } });
    // Evidence remains retrievable offline, independent of scan state.
    const loaded = await storage.evidence.load(state.scanId);
    assert.equal(loaded?.vaptFindings?.length, 1);
    assert.equal((await storage.scans.get(state.scanId))?.status, "failed");
  });
});
