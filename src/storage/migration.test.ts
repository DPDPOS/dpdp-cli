import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import type { Finding } from "../evidence/types.js";
import { openStorage } from "./index.js";
import { STORAGE_SCHEMA_VERSION } from "./schema.js";

async function makeRoot(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpdp-migrate-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const LEGACY_FINDINGS: Finding[] = [
  {
    sourceType: "CODE",
    location: "src/a.ts:1",
    findingType: "consent_reference",
    excerpt: "// consent",
    confidence: 0.85,
    controlCandidates: ["DPDP-CONSENT-COLLECT"],
    sourceHash: "aa",
  },
];

function legacyConfig(overrides: Record<string, unknown> = {}) {
  return {
    apiBaseUrl: "http://127.0.0.1:3000",
    token: "dpdp_legacy_token",
    assessmentId: "assess-legacy",
    lastScanJobId: "job-legacy",
    lastFindings: LEGACY_FINDINGS,
    ...overrides,
  };
}

describe("legacy config loading", () => {
  test("a v1 config.json is detected and migrated", async (t) => {
    const root = await makeRoot(t);
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify(legacyConfig(), null, 2));
    await openStorage(root);
    const schema = JSON.parse(await fs.readFile(path.join(root, "schema.json"), "utf8"));
    assert.equal(schema.schemaVersion, STORAGE_SCHEMA_VERSION);
  });

  test("migration preserves all five legacy fields", async (t) => {
    const root = await makeRoot(t);
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify(legacyConfig(), null, 2));
    const storage = await openStorage(root);

    const config = await storage.config.load();
    assert.equal(config?.apiBaseUrl, "http://127.0.0.1:3000");
    assert.equal(config?.assessmentId, "assess-legacy");

    const credentials = await storage.credentials.load();
    assert.equal(credentials?.token, "dpdp_legacy_token");

    const current = await storage.scans.getCurrent();
    assert.ok(current);
    assert.equal(current.scanJobId, "job-legacy");

    const evidence = await storage.evidence.load(current.scanId);
    assert.deepEqual(evidence?.findings, LEGACY_FINDINGS);
  });

  test("migration is non-destructive: the legacy file is left untouched", async (t) => {
    const root = await makeRoot(t);
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify(legacyConfig(), null, 2));
    await openStorage(root);
    const legacy = JSON.parse(await fs.readFile(path.join(root, "config.json"), "utf8"));
    assert.equal(legacy.token, "dpdp_legacy_token");
    assert.equal(legacy.lastScanJobId, "job-legacy");
  });
});

describe("migration idempotency", () => {
  test("running openStorage twice yields a single scan", async (t) => {
    const root = await makeRoot(t);
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify(legacyConfig(), null, 2));
    await openStorage(root);
    await openStorage(root);
    const storage = await openStorage(root);
    const scans = await storage.scans.list();
    assert.equal(scans.length, 1);
    assert.equal((await storage.evidence.load(scans[0]!.scanId))?.findings.length, 1);
  });

  test("re-running after a partial failure (schema marker removed) produces the same scan id", async (t) => {
    const root = await makeRoot(t);
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify(legacyConfig(), null, 2));
    await openStorage(root);
    await fs.rm(path.join(root, "schema.json"));
    await openStorage(root); // re-migrates deterministically
    const storage = await openStorage(root);
    const scans = await storage.scans.list();
    assert.equal(scans.length, 1);
    assert.equal((await storage.scans.getCurrent())?.scanId, scans[0]?.scanId);
  });
});

describe("invalid / unsupported storage", () => {
  test("unsupported future schema version is rejected with a clear error", async (t) => {
    const root = await makeRoot(t);
    await fs.writeFile(path.join(root, "schema.json"), JSON.stringify({ schemaVersion: 999 }, null, 2));
    await assert.rejects(openStorage(root), /Unsupported storage schema version 999/);
  });

  test("corrupt legacy config reports a clear migration error", async (t) => {
    const root = await makeRoot(t);
    await fs.writeFile(path.join(root, "config.json"), "{ not json !!");
    await assert.rejects(openStorage(root), /Corrupt JSON/);
  });

  test("corrupt schema.json reports a clear error", async (t) => {
    const root = await makeRoot(t);
    await fs.writeFile(path.join(root, "schema.json"), "garbage");
    await assert.rejects(openStorage(root), /Corrupt JSON/);
  });

  test("invalid new-format configuration is rejected", async (t) => {
    const root = await makeRoot(t);
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config", "config.json"), JSON.stringify({ apiBaseUrl: 123 }, null, 2));
    const storage = await openStorage(root);
    await assert.rejects(storage.config.load(), /Invalid configuration/);
  });

  test("corrupted scan state produces a useful error", async (t) => {
    const root = await makeRoot(t);
    await fs.mkdir(path.join(root, "state", "scans"), { recursive: true });
    await fs.writeFile(path.join(root, "state", "scans", "scan-bad.json"), "not json");
    const storage = await openStorage(root);
    await assert.rejects(storage.scans.get("scan-bad"), /Corrupt JSON/);
  });
});

describe("missing storage directories", () => {
  test("a fresh root initializes all directories and the schema marker", async (t) => {
    const root = await makeRoot(t);
    const storage = await openStorage(root);
    assert.equal(await storage.config.load(), null);
    assert.equal(await storage.credentials.load(), null);
    assert.equal(await storage.scans.getCurrent(), null);
    const schema = JSON.parse(await fs.readFile(path.join(root, "schema.json"), "utf8"));
    assert.equal(schema.schemaVersion, STORAGE_SCHEMA_VERSION);
    // directories exist
    for (const rel of ["config", "credentials", "state/scans", "evidence"]) {
      await fs.access(path.join(root, rel));
    }
  });

  test("legacy config without scan data still migrates config and credentials", async (t) => {
    const root = await makeRoot(t);
    await fs.writeFile(
      path.join(root, "config.json"),
      JSON.stringify({ apiBaseUrl: "http://x", token: "dpdp_x", assessmentId: "" }, null, 2),
    );
    const storage = await openStorage(root);
    assert.equal((await storage.config.load())?.apiBaseUrl, "http://x");
    assert.equal((await storage.credentials.load())?.token, "dpdp_x");
    assert.equal(await storage.scans.getCurrent(), null);
  });
});
