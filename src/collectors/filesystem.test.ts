import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { classifyFile, FilesystemCollector } from "./filesystem.js";

describe("classifyFile", () => {
  test("classifies known extensions per kind", () => {
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".rb", ".php", ".cs"]) {
      assert.equal(classifyFile(`src/app${ext}`), "CODE", ext);
    }
    for (const ext of [".json", ".yml", ".yaml", ".toml", ".env", ".ini", ".conf"]) {
      assert.equal(classifyFile(`conf/settings${ext}`), "CONFIG", ext);
    }
    for (const ext of [".md", ".txt", ".rst"]) {
      assert.equal(classifyFile(`docs/readme${ext}`), "DOCUMENT", ext);
    }
  });

  test("treats dotfiles starting with .env as CONFIG", () => {
    assert.equal(classifyFile(".env"), "CONFIG");
    assert.equal(classifyFile(".env.example"), "CONFIG");
    assert.equal(classifyFile("dir/.env.production"), "CONFIG");
  });

  test("extension matching is case-insensitive", () => {
    assert.equal(classifyFile("src/App.TS"), "CODE");
    assert.equal(classifyFile("conf/Settings.JSON"), "CONFIG");
  });

  test("returns null for unsupported files", () => {
    assert.equal(classifyFile("src/app.unknownext"), null);
    assert.equal(classifyFile("README"), null);
    assert.equal(classifyFile("Dockerfile"), null);
  });
});

describe("FilesystemCollector", () => {
  test("discovers files, ignores ignored directories and unsupported files", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpdp-collect-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));

    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "privacy.ts"), "// consent");
    await fs.writeFile(path.join(dir, "config.json"), "{}");
    await fs.writeFile(path.join(dir, "node_modules", "dep.ts"), "// ignore me");
    await fs.writeFile(path.join(dir, ".git", "hook.ts"), "// ignore me");
    await fs.writeFile(path.join(dir, "notes.md"), "hi");
    await fs.writeFile(path.join(dir, "binary.bin"), "nope");

    const files = await new FilesystemCollector().collect(dir);
    const rels = files.map((f) => f.relativePath).sort();
    assert.deepEqual(rels, ["config.json", "notes.md", "src/privacy.ts"]);
    assert.deepEqual(
      files.map((f) => f.kind).sort(),
      ["CODE", "CONFIG", "DOCUMENT"],
    );
  });

  test("supports custom ignore dirs", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpdp-collect-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));

    await fs.mkdir(path.join(dir, "generated"), { recursive: true });
    await fs.writeFile(path.join(dir, "a.ts"), "// a");
    await fs.writeFile(path.join(dir, "generated", "b.ts"), "// b");

    const files = await new FilesystemCollector(new Set(["generated"])).collect(dir);
    assert.deepEqual(files.map((f) => f.relativePath), ["a.ts"]);
  });
});
