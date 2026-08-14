/**
 * Lightweight, tagged error taxonomy. No logging framework — just enough
 * structure to separate failure domains (file discovery, analyzers,
 * storage, HTTP) without changing error messages consumers already rely on.
 */

export const ERROR_CODES = {
  FILE_READ: "scanner.file_read",
  ANALYZER: "scanner.analyzer",
  STORAGE_READ: "storage.read",
  STORAGE_WRITE: "storage.write",
  STORAGE_CORRUPT: "storage.corrupt",
  STORAGE_MIGRATION: "storage.migration",
  STORAGE_SCHEMA: "storage.schema",
  PATH_UNSAFE: "storage.path_unsafe",
  VAPT_SCOPE: "vapt.scope",
  VAPT_OUT_OF_SCOPE: "vapt.out_of_scope",
  VAPT_CHECK: "vapt.check",
  VAPT_ENGINE: "vapt.engine",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class ScanError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScanError";
    this.code = code;
  }
}

export function isScanError(err: unknown): err is ScanError {
  return err instanceof ScanError;
}

export class StorageError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}

export function isStorageError(err: unknown): err is StorageError {
  return err instanceof StorageError;
}

export class VaptError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaptError";
    this.code = code;
  }
}

export function isVaptError(err: unknown): err is VaptError {
  return err instanceof VaptError;
}
