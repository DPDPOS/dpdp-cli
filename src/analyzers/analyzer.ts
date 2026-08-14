import type { ScanContext } from "../core/scanner/scan-context.js";
import type { RawFinding, SourceKind } from "../evidence/types.js";

/**
 * An Analyzer interprets collected input and produces structured evidence
 * (`RawFinding` records).
 *
 * Analyzers receive a read-only `ScanContext` and must never mutate
 * customer files. Implementations may be synchronous or asynchronous; the
 * scanner engine awaits the result either way.
 */
export interface Analyzer {
  /** Stable unique identifier, e.g. "regex-source". */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Source kinds this analyzer can interpret. */
  readonly supportedKinds: readonly SourceKind[];
  analyze(context: ScanContext): RawFinding[] | Promise<RawFinding[]>;
}
