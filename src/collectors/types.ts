import type { SourceKind } from "../evidence/types.js";

/** A file discovered by a collector, classified into a known kind. */
export type CollectedFile = {
  absolutePath: string;
  /** Path relative to the scan target (used for finding locations). */
  relativePath: string;
  kind: SourceKind;
};

/**
 * Minimal collector contract: obtain raw input for the pipeline.
 *
 * Today this is file discovery; later collectors (process, network,
 * environment, ...) can implement the same small interface without the
 * engine changing.
 */
export interface FileCollector {
  collect(targetPath: string): Promise<CollectedFile[]>;
}
