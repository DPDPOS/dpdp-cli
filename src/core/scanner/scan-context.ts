import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { SourceKind } from "../../evidence/types.js";
import { ERROR_CODES, ScanError } from "../../shared/errors.js";

/**
 * Read-only per-file context handed to analyzers.
 *
 * Analyzers must never mutate customer files: this context is frozen at
 * creation and only ever exposes a snapshot (content + metadata) read from
 * disk. `targetPath`/`absolutePath` are provided for analyzers that need
 * them; the rest is the minimal information a file analyzer requires.
 */
export type ScanContext = Readonly<{
  /** Absolute path of the scan root. */
  targetPath: string;
  /** Absolute path of the file being analyzed. */
  absolutePath: string;
  /** Path relative to the scan root (used in finding locations). */
  relativePath: string;
  /** Classified kind of the file. */
  kind: SourceKind;
  /** UTF-8 decoded file content. */
  content: string;
  /** SHA-256 of the decoded content (identical to the original scanner). */
  sourceHash: string;
  /** Byte length of the raw file. */
  sizeBytes: number;
}>;

export type CreateScanContextInput = {
  targetPath: string;
  absolutePath: string;
  relativePath: string;
  kind: SourceKind;
};

/**
 * Read a file into a ScanContext.
 *
 * Throws `ScanError(ERROR_CODES.FILE_READ)` when the file cannot be read;
 * the engine decides whether to abort or skip (it skips and records the
 * issue, so one unreadable file never terminates a scan).
 */
export async function createScanContext(
  input: CreateScanContextInput,
): Promise<ScanContext> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(input.absolutePath);
  } catch (err) {
    throw new ScanError(
      ERROR_CODES.FILE_READ,
      `Cannot read ${input.relativePath}`,
      { cause: err },
    );
  }
  const content = buf.toString("utf8");
  const sourceHash = createHash("sha256").update(content).digest("hex");
  return Object.freeze({
    targetPath: input.targetPath,
    absolutePath: input.absolutePath,
    relativePath: input.relativePath,
    kind: input.kind,
    content,
    sourceHash,
    sizeBytes: buf.length,
  });
}
