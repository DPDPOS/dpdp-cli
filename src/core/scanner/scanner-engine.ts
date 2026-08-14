import path from "node:path";
import type { Analyzer } from "../../analyzers/analyzer.js";
import type { FileCollector } from "../../collectors/types.js";
import { deduplicate } from "../../evidence/deduplicate.js";
import { normalizeFinding } from "../../evidence/normalize.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceBundle,
  type Finding,
} from "../../evidence/types.js";
import { ERROR_CODES, isScanError } from "../../shared/errors.js";
import { AnalyzerRegistry } from "./analyzer-registry.js";
import { createScanContext, type ScanContext } from "./scan-context.js";

export type ScannerEngineOptions = {
  collector: FileCollector;
  registry: AnalyzerRegistry;
  /** Files larger than this many bytes are skipped (preserved default). */
  maxFileBytes?: number;
};

/** A non-fatal problem encountered during a scan. */
export type ScanIssue = {
  code: string;
  message: string;
  file?: string;
};

export type ScanResult = {
  bundle: EvidenceBundle;
  /** Non-fatal issues (unreadable file, analyzer failure). Never abort a scan. */
  issues: ScanIssue[];
};

/**
 * Orchestrates the evidence pipeline:
 *
 *   discover files → classify → create ScanContext
 *     → run registered analyzers → normalize evidence → deduplicate
 *     → EvidenceBundle
 *
 * The engine contains no feature-specific detection rules — it executes
 * whatever analyzers are registered. It does not depend on Commander or
 * any CLI/HTTP concern.
 */
export class ScannerEngine {
  private readonly collector: FileCollector;
  private readonly registry: AnalyzerRegistry;
  private readonly maxFileBytes: number;

  constructor(options: ScannerEngineOptions) {
    this.collector = options.collector;
    this.registry = options.registry;
    this.maxFileBytes = options.maxFileBytes ?? 1_500_000;
  }

  async scan(targetPath: string): Promise<ScanResult> {
    const root = path.resolve(targetPath);
    const issues: ScanIssue[] = [];
    const findings: Finding[] = [];

    const files = await this.collector.collect(targetPath);

    for (const file of files) {
      let context: ScanContext;
      try {
        context = await createScanContext({
          targetPath: root,
          absolutePath: file.absolutePath,
          relativePath: file.relativePath,
          kind: file.kind,
        });
      } catch (err) {
        issues.push({
          code: isScanError(err) ? err.code : "scanner.file_read",
          message: err instanceof Error ? err.message : String(err),
          file: file.relativePath,
        });
        continue; // one unreadable file must not terminate the scan
      }

      if (context.sizeBytes > this.maxFileBytes) continue; // silent skip, as before

      for (const analyzer of this.registry.forKind(context.kind)) {
        let raw;
        try {
          raw = await analyzer.analyze(context);
        } catch (err) {
          issues.push({
            code: ERROR_CODES.ANALYZER,
            message: `Analyzer ${analyzer.id} failed on ${context.relativePath}: ${
              err instanceof Error ? err.message : String(err)
            }`,
            file: context.relativePath,
          });
          continue;
        }
        for (const finding of raw) {
          findings.push(normalizeFinding(finding, context));
        }
      }
    }

    return {
      bundle: {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        findings: deduplicate(findings),
      },
      issues,
    };
  }
}
