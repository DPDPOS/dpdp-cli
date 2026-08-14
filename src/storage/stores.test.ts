import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import type { EvidenceBundle, Finding } from "../evidence/types.js";
import { assertSafeId } from "./fs-utils.js";
import { openStorage } from "./index.js";

async function makeRoot(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpdp-stores-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function bundle(findings: Finding[] = []): EvidenceBundle {
  return { schemaVersion: 1, findings };
}

describe("config store", () => {
  test("persists and reloads configuration", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    assert.equal(await storage.config.load(), null);
    await storage.config.save({ apiBaseUrl: "http://a", assessmentId: "assess-1" });
    assert.deepEqual(await storage.config.load(), {
      apiBaseUrl: "http://a",
      assessmentId: "assess-1",
    });
  });
});

describe("credential store", () => {
  test("persists and reloads credentials", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    assert.equal(await storage.credentials.load(), null);
    await storage.credentials.save({ token: "dpdp_secret" });
    assert.deepEqual(await storage.credentials.load(), { token: "dpdp_secret" });
  });

  test("token never appears in config, state or evidence files", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    await storage.credentials.save({ token: "dpdp_super_secret" });
    await storage.config.save({ apiBaseUrl: "http://a", assessmentId: "assess-1" });
    const state = await storage.scans.create({ assessmentId: "assess-1" });
    await storage.scans.setCurrentScanId(state.scanId);
    await storage.evidence.save(state.scanId, bundle([{
      sourceType: "CODE",
      location: "a.ts:1",
      findingType: "consent_reference",
      confidence: 0.85,
      controlCandidates: [],
    }]));

    const configRaw = await fs.readFile(path.join(root, "config", "config.json"), "utf8");
    const stateRaw = await fs.readFile(path.join(root, "state", "scans", `${state.scanId}.json`), "utf8");
    const evidenceRaw = await fs.readFile(path.join(root, "evidence", `${state.scanId}.json`), "utf8");
    const currentRaw = await fs.readFile(path.join(root, "state", "current-scan.json"), "utf8");
    for (const raw of [configRaw, stateRaw, evidenceRaw, currentRaw]) {
      assert.ok(!raw.includes("dpdp_super_secret"), "token leaked into non-credential file");
    }
  });

  test("credential file permissions are restrictive on POSIX", async (t) => {
    if (process.platform === "win32") {
      t.skip("Unix-style permissions are not enforced on Windows");
      return;
    }
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    await storage.credentials.save({ token: "dpdp_secret" });
    const stat = await fs.stat(path.join(root, "credentials", "credentials.json"));
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

describe("scan state store", () => {
  test("create / get / update roundtrip", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    const created = await storage.scans.create({
      assessmentId: "assess-1",
      targetType: "MIXED",
      targetPath: "/tmp/target",
    });
    assert.equal(created.status, "scanned");
    assert.equal(created.assessmentId, "assess-1");
    assert.ok(created.scanId.startsWith("scan-"));
    assert.ok(created.timestamps.scannedAt);

    const got = await storage.scans.get(created.scanId);
    assert.deepEqual(got, created);

    await storage.scans.update(created.scanId, { scanJobId: "job-1", status: "job_created" });
    const updated = await storage.scans.get(created.scanId);
    assert.equal(updated?.scanJobId, "job-1");
    assert.equal(updated?.status, "job_created");
    assert.ok(updated?.timestamps.scannedAt, "update must not drop scannedAt");
  });

  test("current scan pointer", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    assert.equal(await storage.scans.getCurrent(), null);
    const a = await storage.scans.create({ assessmentId: "assess-1" });
    const b = await storage.scans.create({ assessmentId: "assess-1" });
    await storage.scans.setCurrentScanId(b.scanId);
    assert.equal((await storage.scans.getCurrent())?.scanId, b.scanId);
    assert.equal((await storage.scans.getCurrentScanId()), b.scanId);
    assert.equal((await storage.scans.get(a.scanId))?.scanId, a.scanId);
  });
});

describe("evidence store", () => {
  test("persists and reloads evidence", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    const findings: Finding[] = [{
      sourceType: "CONFIG",
      location: "c.json:1",
      findingType: "retention_config",
      confidence: 0.85,
      controlCandidates: [],
    }];
    await storage.evidence.save("scan-abc", bundle(findings));
    const loaded = await storage.evidence.load("scan-abc");
    assert.equal(loaded?.scanId, "scan-abc");
    assert.equal(loaded?.schemaVersion, 1);
    assert.deepEqual(loaded?.findings, findings);
    assert.equal(await storage.evidence.exists("scan-abc"), true);
    assert.equal(await storage.evidence.load("scan-missing"), null);
  });

  test("offline evidence retrieval works without config or credentials", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    const findings: Finding[] = [{
      sourceType: "CODE",
      location: "a.ts:1",
      findingType: "breach_reference",
      confidence: 0.85,
      controlCandidates: [],
    }];
    await storage.evidence.save("scan-abc", bundle(findings));
    // No config / credentials exist; evidence is still available offline.
    assert.equal(await storage.config.load(), null);
    assert.equal(await storage.credentials.load(), null);
    assert.deepEqual((await storage.evidence.load("scan-abc"))?.findings, findings);
  });

  test("multiple scans keep separate artifacts and do not overwrite", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    const a = await storage.scans.create({ assessmentId: "assess-1" });
    const b = await storage.scans.create({ assessmentId: "assess-1" });
    await storage.evidence.save(a.scanId, bundle([{
      sourceType: "CODE", location: "a.ts:1", findingType: "one", confidence: 0.85, controlCandidates: [],
    }]));
    await storage.evidence.save(b.scanId, bundle([{
      sourceType: "CODE", location: "b.ts:1", findingType: "two", confidence: 0.85, controlCandidates: [],
    }]));
    assert.deepEqual(
      (await storage.evidence.load(a.scanId))?.findings.map((f) => f.findingType),
      ["one"],
    );
    assert.deepEqual(
      (await storage.evidence.load(b.scanId))?.findings.map((f) => f.findingType),
      ["two"],
    );
    assert.equal((await storage.scans.list()).length, 2);
  });
});

describe("atomic writes", () => {
  test("writes leave no temporary files behind", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    await storage.config.save({ apiBaseUrl: "http://a", assessmentId: "x" });
    await storage.config.save({ apiBaseUrl: "http://b", assessmentId: "y" });
    await storage.credentials.save({ token: "dpdp_t" });
    const leftovers: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.includes(".tmp")) leftovers.push(full);
      }
    };
    await walk(root);
    assert.deepEqual(leftovers, []);
  });

  test("concurrent writes never corrupt the file", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        storage.config.save({ apiBaseUrl: `http://${i}`, assessmentId: `a${i}` }),
      ),
    );
    const config = await storage.config.load();
    assert.ok(config, "file must remain valid JSON after concurrent writes");
    assert.match(config.apiBaseUrl, /^http:\/\/\d+$/);
  });
});

describe("path safety", () => {
  test("unsafe identifiers are rejected before use in artifact paths", () => {
    const bad = [
      "../evil",
      "..",
      "a/b",
      "a\\b",
      "/etc/passwd",
      "a b",
      "a.json",
      ".hidden",
      "",
      "-leading",
      "a".repeat(200),
    ];
    for (const id of bad) {
      assert.throws(() => assertSafeId(id), /Unsafe/, id);
    }
    assert.equal(assertSafeId("scan-abc123"), "scan-abc123");
    assert.equal(assertSafeId("9f2c4b7a8e6d1c3a"), "9f2c4b7a8e6d1c3a");
  });

  test("stores reject traversal ids", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    await assert.rejects(storage.evidence.save("../evil", bundle()), /Unsafe/);
    await assert.rejects(storage.evidence.load("../evil"), /Unsafe/);
    await assert.rejects(storage.scans.get("/etc/passwd"), /Unsafe/);
    await assert.rejects(storage.scans.setCurrentScanId("a/b"), /Unsafe/);
  });
});
