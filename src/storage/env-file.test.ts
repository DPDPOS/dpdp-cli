import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  buildGroqEnvVars,
  envFilePath,
  hasGroqKey,
  loadEnvFileIntoProcess,
  parseEnvFile,
  readEnvFile,
  serializeEnvFile,
  writeEnvFile,
} from "./env-file.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpdp-env-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// 1. parseEnvFile
// ---------------------------------------------------------------------------

describe("parseEnvFile", () => {
  test("parses simple KEY=value pairs", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux\n");
    assert.deepEqual(result, { FOO: "bar", BAZ: "qux" });
  });

  test("handles double-quoted values", () => {
    const result = parseEnvFile('FOO="hello world"\n');
    assert.equal(result.FOO, "hello world");
  });

  test("handles single-quoted values", () => {
    const result = parseEnvFile("FOO='hello world'\n");
    assert.equal(result.FOO, "hello world");
  });

  test("skips comments and blank lines", () => {
    const result = parseEnvFile("# comment\n\nFOO=bar\n# another\n");
    assert.deepEqual(result, { FOO: "bar" });
  });

  test("handles values with equals signs", () => {
    const result = parseEnvFile("FOO=bar=baz\n");
    assert.equal(result.FOO, "bar=baz");
  });

  test("returns empty object for empty input", () => {
    assert.deepEqual(parseEnvFile(""), {});
    assert.deepEqual(parseEnvFile("# just a comment\n"), {});
  });

  test("ignores lines without equals sign", () => {
    const result = parseEnvFile("NOT_AN_ASSIGNMENT\nFOO=bar\n");
    assert.deepEqual(result, { FOO: "bar" });
  });
});

// ---------------------------------------------------------------------------
// 2. serializeEnvFile
// ---------------------------------------------------------------------------

describe("serializeEnvFile", () => {
  test("serializes key=value pairs", () => {
    const result = serializeEnvFile({ FOO: "bar", BAZ: "qux" });
    assert.equal(result, "FOO=bar\nBAZ=qux\n");
  });

  test("handles empty object", () => {
    assert.equal(serializeEnvFile({}), "\n");
  });
});

// ---------------------------------------------------------------------------
// 3. readEnvFile
// ---------------------------------------------------------------------------

describe("readEnvFile", () => {
  test("reads existing .env file", async (t) => {
    const dir = await makeTmpDir(t);
    const filePath = path.join(dir, ".env");
    await fs.writeFile(filePath, "FOO=bar\n");
    const result = await readEnvFile(filePath);
    assert.deepEqual(result, { FOO: "bar" });
  });

  test("returns null for non-existent file", async (t) => {
    const dir = await makeTmpDir(t);
    const result = await readEnvFile(path.join(dir, ".env"));
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// 4. writeEnvFile
// ---------------------------------------------------------------------------

describe("writeEnvFile", () => {
  test("creates new .env with Groq vars", async (t) => {
    const dir = await makeTmpDir(t);
    const filePath = path.join(dir, ".env");
    await writeEnvFile(filePath, null, {
      GROQ_API_KEY: "gsk_test123",
      GROQ_BASE_URL: "https://api.groq.com/openai/v1",
      GROQ_MODEL: "allam-2-7b",
    });
    const content = await fs.readFile(filePath, "utf8");
    assert.ok(content.includes("GROQ_API_KEY=gsk_test123"));
    assert.ok(content.includes("GROQ_BASE_URL=https://api.groq.com/openai/v1"));
    assert.ok(content.includes("GROQ_MODEL=allam-2-7b"));
  });

  test("preserves existing non-GROQ variables", async (t) => {
    const dir = await makeTmpDir(t);
    const filePath = path.join(dir, ".env");
    const existing = "MY_APP_CONFIG=true\nDATABASE_URL=postgres://localhost\n";
    await fs.writeFile(filePath, existing);
    await writeEnvFile(filePath, existing, {
      GROQ_API_KEY: "gsk_test123",
      GROQ_BASE_URL: "https://api.groq.com/openai/v1",
      GROQ_MODEL: "allam-2-7b",
    });
    const content = await fs.readFile(filePath, "utf8");
    assert.ok(content.includes("MY_APP_CONFIG=true"));
    assert.ok(content.includes("DATABASE_URL=postgres://localhost"));
    assert.ok(content.includes("GROQ_API_KEY=gsk_test123"));
  });

  test("replaces existing GROQ vars", async (t) => {
    const dir = await makeTmpDir(t);
    const filePath = path.join(dir, ".env");
    const existing =
      "MY_VAR=yes\nGROQ_API_KEY=old_key\nGROQ_BASE_URL=https://old.url\nGROQ_MODEL=old-model\n";
    await fs.writeFile(filePath, existing);
    await writeEnvFile(filePath, existing, {
      GROQ_API_KEY: "gsk_new_key",
      GROQ_BASE_URL: "https://api.groq.com/openai/v1",
      GROQ_MODEL: "allam-2-7b",
    });
    const content = await fs.readFile(filePath, "utf8");
    assert.ok(content.includes("MY_VAR=yes"));
    assert.ok(content.includes("GROQ_API_KEY=gsk_new_key"));
    assert.ok(!content.includes("old_key"));
    assert.ok(!content.includes("old.url"));
    assert.ok(!content.includes("old-model"));
  });

  test("preserves comments", async (t) => {
    const dir = await makeTmpDir(t);
    const filePath = path.join(dir, ".env");
    const existing = "# My app config\nMY_VAR=true\n# Groq config\nGROQ_API_KEY=old\n";
    await fs.writeFile(filePath, existing);
    await writeEnvFile(filePath, existing, {
      GROQ_API_KEY: "new_key",
      GROQ_BASE_URL: "https://api.groq.com/openai/v1",
      GROQ_MODEL: "allam-2-7b",
    });
    const content = await fs.readFile(filePath, "utf8");
    assert.ok(content.includes("# My app config"));
    assert.ok(content.includes("MY_VAR=true"));
    assert.ok(content.includes("# Groq config"));
    assert.ok(content.includes("GROQ_API_KEY=new_key"));
  });

  test("file has restrictive permissions on POSIX", async (t) => {
    if (process.platform === "win32") {
      t.skip("Unix-style permissions are not enforced on Windows");
      return;
    }
    const dir = await makeTmpDir(t);
    const filePath = path.join(dir, ".env");
    await writeEnvFile(filePath, null, { GROQ_API_KEY: "test" });
    const stat = await fs.stat(filePath);
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

// ---------------------------------------------------------------------------
// 5. loadEnvFileIntoProcess
// ---------------------------------------------------------------------------

describe("loadEnvFileIntoProcess", () => {
  // Save/restore helpers for process.env
  function saveEnv(keys: string[]): Map<string, string | undefined> {
    const saved = new Map<string, string | undefined>();
    for (const k of keys) saved.set(k, process.env[k]);
    return saved;
  }
  function restoreEnv(saved: Map<string, string | undefined>): void {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  test("loads GROQ_API_KEY into process.env", async (t) => {
    const dir = await makeTmpDir(t);
    const filePath = path.join(dir, ".env");
    await fs.writeFile(filePath, "GROQ_API_KEY=gsk_test_load\n");

    const saved = saveEnv(["GROQ_API_KEY"]);
    t.after(() => restoreEnv(saved));
    delete process.env.GROQ_API_KEY;

    const loaded = await loadEnvFileIntoProcess(filePath);
    assert.equal(loaded, true);
    assert.equal(process.env.GROQ_API_KEY, "gsk_test_load");
  });

  test("loads GROQ_BASE_URL into process.env", async (t) => {
    const dir = await makeTmpDir(t);
    const filePath = path.join(dir, ".env");
    await fs.writeFile(filePath, "GROQ_BASE_URL=https://custom.api/v1\n");

    const saved = saveEnv(["GROQ_BASE_URL"]);
    t.after(() => restoreEnv(saved));
    delete process.env.GROQ_BASE_URL;

    const loaded = await loadEnvFileIntoProcess(filePath);
    assert.equal(loaded, true);
    assert.equal(process.env.GROQ_BASE_URL, "https://custom.api/v1");
  });

  test("loads GROQ_MODEL into process.env", async (t) => {
    const dir = await makeTmpDir(t);
    const filePath = path.join(dir, ".env");
    await fs.writeFile(filePath, "GROQ_MODEL=mixtral-8x7b\n");

    const saved = saveEnv(["GROQ_MODEL"]);
    t.after(() => restoreEnv(saved));
    delete process.env.GROQ_MODEL;

    const loaded = await loadEnvFileIntoProcess(filePath);
    assert.equal(loaded, true);
    assert.equal(process.env.GROQ_MODEL, "mixtral-8x7b");
  });

  test("does NOT load arbitrary variables (NODE_OPTIONS, LD_PRELOAD, etc.)", async (t) => {
    const dir = await makeTmpDir(t);
    const filePath = path.join(dir, ".env");
    await fs.writeFile(
      filePath,
      "NODE_OPTIONS=--require=/tmp/evil.js\nLD_PRELOAD=/tmp/evil.so\nHTTP_PROXY=http://attacker:8080\nPATH=/evil/bin\nGROQ_API_KEY=gsk_real\nnpm_config_registry=http://attacker\n",
    );

    const saved = saveEnv([
      "GROQ_API_KEY",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "HTTP_PROXY",
      "PATH",
      "npm_config_registry",
    ]);
    t.after(() => restoreEnv(saved));
    delete process.env.GROQ_API_KEY;
    delete process.env.NODE_OPTIONS;
    delete process.env.LD_PRELOAD;
    delete process.env.HTTP_PROXY;
    // Don't delete PATH — just check it's not overwritten
    delete process.env.npm_config_registry;

    await loadEnvFileIntoProcess(filePath);

    // GROQ_API_KEY should be loaded
    assert.equal(process.env.GROQ_API_KEY, "gsk_real");
    // Arbitrary keys must NOT be loaded
    assert.equal(process.env.NODE_OPTIONS, undefined, "NODE_OPTIONS must not be injected");
    assert.equal(process.env.LD_PRELOAD, undefined, "LD_PRELOAD must not be injected");
    assert.equal(process.env.HTTP_PROXY, undefined, "HTTP_PROXY must not be injected");
    assert.equal(process.env.npm_config_registry, undefined, "npm_config_registry must not be injected");
  });

  test("does not overwrite existing process.env GROQ_* vars", async (t) => {
    const dir = await makeTmpDir(t);
    const filePath = path.join(dir, ".env");
    await fs.writeFile(filePath, "GROQ_API_KEY=gsk_from_file\n");

    const saved = saveEnv(["GROQ_API_KEY"]);
    t.after(() => restoreEnv(saved));
    process.env.GROQ_API_KEY = "gsk_from_process";

    const loaded = await loadEnvFileIntoProcess(filePath);
    assert.equal(loaded, true);
    assert.equal(process.env.GROQ_API_KEY, "gsk_from_process", "existing process.env value must not be overwritten");
  });

  test("returns false for non-existent file", async (t) => {
    const dir = await makeTmpDir(t);
    const loaded = await loadEnvFileIntoProcess(path.join(dir, ".env"));
    assert.equal(loaded, false);
  });

  test("existing process.env GROQ_* behavior remains correct", async (t) => {
    const saved = saveEnv(["GROQ_API_KEY", "GROQ_BASE_URL", "GROQ_MODEL"]);
    t.after(() => restoreEnv(saved));

    // Simulate: user has GROQ_API_KEY in process.env, no .env file
    process.env.GROQ_API_KEY = "gsk_explicit";
    delete process.env.GROQ_BASE_URL;
    delete process.env.GROQ_MODEL;

    const dir = await makeTmpDir(t);
    const filePath = path.join(dir, ".env");
    await fs.writeFile(filePath, "GROQ_API_KEY=gsk_should_not_override\n");

    await loadEnvFileIntoProcess(filePath);

    assert.equal(process.env.GROQ_API_KEY, "gsk_explicit", "process.env GROQ_API_KEY must be preserved");
    assert.equal(process.env.GROQ_BASE_URL, undefined, "GROQ_BASE_URL not in process.env and not in .env");
  });
});

// ---------------------------------------------------------------------------
// 6. buildGroqEnvVars
// ---------------------------------------------------------------------------

describe("buildGroqEnvVars", () => {
  test("returns correct defaults", () => {
    const vars = buildGroqEnvVars("gsk_test123");
    assert.equal(vars.GROQ_API_KEY, "gsk_test123");
    assert.equal(vars.GROQ_BASE_URL, "https://api.groq.com/openai/v1");
    assert.equal(vars.GROQ_MODEL, "allam-2-7b");
  });
});

// ---------------------------------------------------------------------------
// 7. hasGroqKey
// ---------------------------------------------------------------------------

describe("hasGroqKey", () => {
  test("returns true when key exists and non-empty", () => {
    assert.equal(hasGroqKey({ GROQ_API_KEY: "gsk_abc" }), true);
  });

  test("returns false when key is missing", () => {
    assert.equal(hasGroqKey({}), false);
  });

  test("returns false when key is empty string", () => {
    assert.equal(hasGroqKey({ GROQ_API_KEY: "" }), false);
  });

  test("returns false when key is whitespace only", () => {
    assert.equal(hasGroqKey({ GROQ_API_KEY: "   " }), false);
  });
});

// ---------------------------------------------------------------------------
// 8. envFilePath
// ---------------------------------------------------------------------------

describe("envFilePath", () => {
  test("returns .env path in given directory", () => {
    assert.equal(envFilePath("/home/user/project"), "/home/user/project/.env");
  });
});

// ---------------------------------------------------------------------------
// 9. End-to-end: create → read → overwrite
// ---------------------------------------------------------------------------

describe("env-file end-to-end", () => {
  test("create, read back, then overwrite preserves non-GROQ vars", async (t) => {
    const dir = await makeTmpDir(t);
    const filePath = path.join(dir, ".env");

    // Step 1: Create
    await writeEnvFile(filePath, null, {
      GROQ_API_KEY: "gsk_first",
      GROQ_BASE_URL: "https://api.groq.com/openai/v1",
      GROQ_MODEL: "allam-2-7b",
    });

    // Step 2: Read back
    const vars1 = await readEnvFile(filePath);
    assert.ok(vars1);
    assert.equal(vars1.GROQ_API_KEY, "gsk_first");

    // Step 3: Add a non-GROQ var manually
    const content1 = await fs.readFile(filePath, "utf8");
    const withExtra = content1 + "CUSTOM_VAR=hello\n";
    await fs.writeFile(filePath, withExtra);

    // Step 4: Overwrite GROQ vars
    const content2 = await fs.readFile(filePath, "utf8");
    await writeEnvFile(filePath, content2, {
      GROQ_API_KEY: "gsk_second",
      GROQ_BASE_URL: "https://api.groq.com/openai/v1",
      GROQ_MODEL: "allam-2-7b",
    });

    // Step 5: Verify
    const vars2 = await readEnvFile(filePath);
    assert.ok(vars2);
    assert.equal(vars2.GROQ_API_KEY, "gsk_second");
    assert.equal(vars2.CUSTOM_VAR, "hello");
  });
});
