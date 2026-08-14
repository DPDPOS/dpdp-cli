import { RegexAnalyzer } from "../../analyzers/source/regex/regex-analyzer.js";
import { FilesystemCollector } from "../../collectors/filesystem.js";
import { AnalyzerRegistry } from "../scanner/analyzer-registry.js";
import { ScannerEngine } from "../scanner/scanner-engine.js";

/**
 * Default scanner profile: the production wiring of the pipeline.
 *
 * This is the composition root — adding a future analyzer means
 * registering it here (plus tests), with no changes to the engine or the
 * CLI entry point.
 */
export function createDefaultScanner(): ScannerEngine {
  const registry = new AnalyzerRegistry();
  registry.register(new RegexAnalyzer());
  return new ScannerEngine({
    collector: new FilesystemCollector(),
    registry,
  });
}
