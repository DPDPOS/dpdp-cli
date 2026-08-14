import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AnalyzerRegistry } from "./analyzer-registry.js";
import type { Analyzer } from "../../analyzers/analyzer.js";
import type { ScanContext } from "./scan-context.js";

function fakeAnalyzer(id: string, kinds: ("CODE" | "CONFIG" | "DOCUMENT")[]): Analyzer {
  return {
    id,
    name: `Fake ${id}`,
    supportedKinds: kinds,
    analyze(_ctx: ScanContext) {
      return [];
    },
  };
}

describe("AnalyzerRegistry", () => {
  test("register, get, list", () => {
    const registry = new AnalyzerRegistry();
    const a = fakeAnalyzer("a", ["CODE"]);
    registry.register(a);
    assert.equal(registry.get("a"), a);
    assert.deepEqual(registry.list(), [a]);
  });

  test("rejects duplicate analyzer ids", () => {
    const registry = new AnalyzerRegistry();
    registry.register(fakeAnalyzer("dup", ["CODE"]));
    assert.throws(() => registry.register(fakeAnalyzer("dup", ["CONFIG"])), /already registered/);
  });

  test("forKind filters by supported kinds", () => {
    const registry = new AnalyzerRegistry();
    const codeOnly = fakeAnalyzer("code-only", ["CODE"]);
    const all = fakeAnalyzer("all", ["CODE", "CONFIG", "DOCUMENT"]);
    const configOnly = fakeAnalyzer("config-only", ["CONFIG"]);
    registry.register(codeOnly);
    registry.register(all);
    registry.register(configOnly);

    assert.deepEqual(registry.forKind("CODE"), [codeOnly, all]);
    assert.deepEqual(registry.forKind("CONFIG"), [all, configOnly]);
    assert.deepEqual(registry.forKind("DOCUMENT"), [all]);
  });

  test("unregister removes an analyzer", () => {
    const registry = new AnalyzerRegistry();
    const a = fakeAnalyzer("a", ["CODE"]);
    registry.register(a);
    assert.equal(registry.unregister("a"), true);
    assert.equal(registry.get("a"), undefined);
    assert.equal(registry.unregister("a"), false);
  });
});
