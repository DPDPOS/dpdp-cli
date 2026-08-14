import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import type { Analyzer } from "../../analyzers/analyzer.js";
import { RegexAnalyzer } from "../../analyzers/source/regex/regex-analyzer.js";
import { FilesystemCollector } from "../../collectors/filesystem.js";
import type { FileCollector } from "../../collectors/types.js";
import type { RawFinding } from "../../evidence/types.js";
import { AnalyzerRegistry } from "./analyzer-registry.js";
import { ScannerEngine } from "./scanner-engine.js";
import type { ScanContext } from "./scan-context.js";

const FIXTURES_DIR = fileURLToPath(
  new URL("../../../fixtures/sample-app", import.meta.url),
);

async function makeTempDir(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpdp-engine-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Analyzer that echoes fixed raw findings (for pipeline tests). */
function echoAnalyzer(id: string, raw: RawFinding[]): Analyzer {
  return {
    id,
    name: `Echo ${id}`,
    supportedKinds: ["CODE", "CONFIG", "DOCUMENT"],
    analyze() {
      return raw;
    },
  };
}

describe("ScannerEngine pipeline", () => {
  test("runs registered analyzers and normalizes context fields", async (t) => {
    const dir = await makeTempDir(t);
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    const content = "// consent";
    await fs.writeFile(path.join(dir, "src", "a.ts"), content);

    const registry = new AnalyzerRegistry();
    registry.register(new RegexAnalyzer());
    const engine = new ScannerEngine({ collector: new FilesystemCollector(), registry });

    const { bundle, issues } = await engine.scan(dir);

    assert.deepEqual(issues, []);
    assert.equal(bundle.schemaVersion, 1);
    assert.equal(bundle.findings.length, 1);

    const finding = bundle.findings[0];
    assert.equal(finding?.sourceType, "CODE");
    assert.equal(finding?.location, "src/a.ts:1");
    assert.equal(finding?.findingType, "consent_reference");
    assert.equal(finding?.confidence, 0.85);
    assert.equal(finding?.sourceHash, createHash("sha256").update(content).digest("hex"));
  });

  test("deduplicates findings across analyzers by location+findingType", async (t) => {
    const dir = await makeTempDir(t);
    await fs.writeFile(path.join(dir, "a.ts"), "anything");

    const registry = new AnalyzerRegistry();
    registry.register(
      echoAnalyzer("echo-1", [
        { findingType: "dupe", location: "a.ts:1", confidence: 0.85, controlCandidates: [] },
      ]),
    );
    registry.register(
      echoAnalyzer("echo-2", [
        { findingType: "dupe", location: "a.ts:1", confidence: 0.85, controlCandidates: [] },
        { findingType: "other", location: "a.ts:1", confidence: 0.85, controlCandidates: [] },
      ]),
    );
    const engine = new ScannerEngine({ collector: new FilesystemCollector(), registry });

    const { bundle } = await engine.scan(dir);
    assert.deepEqual(
      bundle.findings.map((f) => f.findingType),
      ["dupe", "other"],
    );
  });

  test("an unreadable file does not terminate the scan", async (t) => {
    const dir = await makeTempDir(t);
    await fs.writeFile(path.join(dir, "good.ts"), "// consent");

    // Stub collector that also yields a file that cannot be read.
    const stub: FileCollector = {
      async collect() {
        return [
          { absolutePath: path.join(dir, "good.ts"), relativePath: "good.ts", kind: "CODE" },
          {
            absolutePath: path.join(dir, "does-not-exist.ts"),
            relativePath: "missing.ts",
            kind: "CODE",
          },
        ];
      },
    };
    const registry = new AnalyzerRegistry();
    registry.register(new RegexAnalyzer());
    const engine = new ScannerEngine({ collector: stub, registry });

    const { bundle, issues } = await engine.scan(dir);

    assert.equal(bundle.findings.length, 1);
    assert.equal(bundle.findings[0]?.location, "good.ts:1");
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.code, "scanner.file_read");
    assert.equal(issues[0]?.file, "missing.ts");
  });

  test("an analyzer failure does not terminate the scan", async (t) => {
    const dir = await makeTempDir(t);
    await fs.writeFile(path.join(dir, "good.ts"), "// consent");

    const broken: Analyzer = {
      id: "broken",
      name: "Broken",
      supportedKinds: ["CODE"],
      analyze() {
        throw new Error("boom");
      },
    };
    const registry = new AnalyzerRegistry();
    registry.register(broken);
    registry.register(new RegexAnalyzer());
    const engine = new ScannerEngine({ collector: new FilesystemCollector(), registry });

    const { bundle, issues } = await engine.scan(dir);

    // Regex analyzer still produced its finding for the same file.
    assert.equal(bundle.findings.length, 1);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.code, "scanner.analyzer");
  });

  test("oversized files are skipped silently", async (t) => {
    const dir = await makeTempDir(t);
    await fs.writeFile(path.join(dir, "big.ts"), "consent " + "x".repeat(100));
    await fs.writeFile(path.join(dir, "small.ts"), "consent");

    const registry = new AnalyzerRegistry();
    registry.register(new RegexAnalyzer());
    // maxFileBytes = 10: big.ts is skipped, small.ts is scanned.
    const engine = new ScannerEngine({
      collector: new FilesystemCollector(),
      registry,
      maxFileBytes: 10,
    });

    const { bundle, issues } = await engine.scan(dir);
    assert.deepEqual(
      bundle.findings.map((f) => f.location),
      ["small.ts:1"],
    );
    assert.deepEqual(issues, []);
  });
});

describe("fixtures/sample-app end-to-end", () => {
  test("scans the sample app with the expected evidence", async () => {
    const engine = new ScannerEngine({
      collector: new FilesystemCollector(),
      registry: (() => {
        const r = new AnalyzerRegistry();
        r.register(new RegexAnalyzer());
        return r;
      })(),
    });

    const { bundle, issues } = await engine.scan(FIXTURES_DIR);
    assert.deepEqual(issues, []);
    assert.equal(bundle.schemaVersion, 1);

    const keys = bundle.findings.map((f) => `${f.location}|${f.findingType}`).sort();
    assert.deepEqual(keys, [
      // .env.example (CONFIG): only CONFIG rules apply
      ".env.example:1|retention_config",
      ".env.example:2|retention_config",
      // docs/privacy-policy.md (DOCUMENT): only DOCUMENT rules apply
      "docs/privacy-policy.md:1|notice_language",
      "docs/privacy-policy.md:4|vendor_reference",
      // src/privacy.ts (CODE): only CODE rules apply
      "src/privacy.ts:10|deletion_endpoint",
      "src/privacy.ts:10|erasure_logic",
      "src/privacy.ts:14|retention_reference",
      "src/privacy.ts:15|breach_reference",
      "src/privacy.ts:3|consent_reference",
      "src/privacy.ts:3|consent_withdrawal",
      "src/privacy.ts:4|consent_reference",
      "src/privacy.ts:4|consent_withdrawal",
      "src/privacy.ts:8|erasure_logic",
      "src/privacy.ts:9|erasure_logic",
    ]);
    assert.equal(bundle.findings.length, 14);

    // Spot checks on the Finding contract.
    for (const finding of bundle.findings) {
      assert.match(finding.location, /^[^:]+:\d+$/);
      assert.equal(finding.confidence, 0.85);
      assert.ok(finding.controlCandidates.length > 0);
      assert.match(finding.sourceHash ?? "", /^[0-9a-f]{64}$/);
      assert.ok(["CODE", "CONFIG", "DOCUMENT"].includes(finding.sourceType));
    }

    // No DOCUMENT rules leak into CODE files (the fixed cross-kind behavior).
    for (const finding of bundle.findings) {
      if (finding.sourceType === "CODE") {
        assert.notEqual(finding.findingType, "notice_language");
        assert.notEqual(finding.findingType, "vendor_reference");
      }
    }
  });
});
