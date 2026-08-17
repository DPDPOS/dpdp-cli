import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ERROR_CODES, StorageError } from "../shared/errors.js";

/**
 * Physical layout of the local storage tree (implementation detail — the
 * rest of the application only sees the store abstractions):
 *
 *   <root>/
 *     schema.json                      storage schema version marker
 *     config/config.json               stable configuration
 *     credentials/credentials.json     bearer token (restrictive mode)
 *     state/current-scan.json          pointer to the current scan
 *     state/scans/<scanId>.json        per-scan state
 *     evidence/<scanId>.json           per-scan evidence artifacts
 */
export type StoragePaths = {
  root: string;
  schema: string;
  /** Legacy single-file config (migration source), untouched after migration. */
  legacyConfig: string;
  config: string;
  credentials: string;
  stateDir: string;
  scansDir: string;
  currentScan: string;
  evidenceDir: string;
  vaptConfigDir: string;
  scanState(scanId: string): string;
  evidence(scanId: string): string;
  /** Per-assessment VAPT configuration (scope/profile). */
  vaptConfig(assessmentId: string): string;
};

export function storagePaths(root: string): StoragePaths {
  return {
    root,
    schema: path.join(root, "schema.json"),
    legacyConfig: path.join(root, "config.json"),
    config: path.join(root, "config", "config.json"),
    credentials: path.join(root, "credentials", "credentials.json"),
    stateDir: path.join(root, "state"),
    scansDir: path.join(root, "state", "scans"),
    currentScan: path.join(root, "state", "current-scan.json"),
    evidenceDir: path.join(root, "evidence"),
    vaptConfigDir: path.join(root, "config", "vapt"),
    scanState: (scanId) =>
      path.join(root, "state", "scans", `${assertSafeId(scanId, "scan id")}.json`),
    evidence: (scanId) =>
      path.join(root, "evidence", `${assertSafeId(scanId, "scan id")}.json`),
    vaptConfig: (assessmentId) =>
      path.join(root, "config", "vapt", `${assertSafeId(assessmentId, "assessment id")}.json`),
  };
}

/**
 * Scan/job/assessment identifiers are treated as untrusted input when they
 * determine artifact paths. Only conservative, portable identifiers pass.
 */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertSafeId(id: string, label = "identifier"): string {
  if (!SAFE_ID_RE.test(id)) {
    throw new StorageError(
      ERROR_CODES.PATH_UNSAFE,
      `Unsafe ${label} for artifact path: ${JSON.stringify(id)}`,
    );
  }
  return id;
}

/**
 * Atomic JSON persistence: write to a temporary file in the same directory,
 * then rename over the target. POSIX rename is atomic. On Windows the
 * destination is removed first because rename cannot overwrite (EPERM).
 */
export async function atomicWriteJson(
  filePath: string,
  data: unknown,
  options?: { mode?: number },
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: options?.mode });
    await replaceFile(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new StorageError(
      ERROR_CODES.STORAGE_WRITE,
      `Cannot write ${filePath}: ${errMessage(err)}`,
      { cause: err },
    );
  }
}

const writeLocks = new Map<string, Promise<void>>();

/**
 * Serialize writes to the same path in-process, then replace the target.
 * Windows `rename` does not overwrite an existing file (EPERM); remove first.
 */
async function replaceFile(tmp: string, dest: string): Promise<void> {
  const key = path.resolve(dest);
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(key, previous.then(() => current));
  await previous;
  try {
    if (process.platform === "win32") {
      await fs.rm(dest, { force: true });
    }
    await fs.rename(tmp, dest);
  } finally {
    release();
    if (writeLocks.get(key) === current) writeLocks.delete(key);
  }
}

/**
 * Read + parse JSON. Returns null when the file does not exist; throws a
 * tagged StorageError for unreadable or corrupt files (never silently
 * treats corrupt data as "missing").
 */
export async function readJsonFile<T = unknown>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new StorageError(
      ERROR_CODES.STORAGE_READ,
      `Cannot read ${filePath}: ${errMessage(err)}`,
      { cause: err },
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new StorageError(
      ERROR_CODES.STORAGE_CORRUPT,
      `Corrupt JSON in ${filePath}: ${errMessage(err)}. Fix or remove the file and retry.`,
      { cause: err },
    );
  }
}

/** Ensure the storage directory tree exists. */
export async function ensureDirs(root: string): Promise<void> {
  const paths = storagePaths(root);
  await Promise.all([
    fs.mkdir(path.dirname(paths.config), { recursive: true }),
    fs.mkdir(path.dirname(paths.credentials), { recursive: true }),
    fs.mkdir(paths.scansDir, { recursive: true }),
    fs.mkdir(paths.evidenceDir, { recursive: true }),
    fs.mkdir(paths.vaptConfigDir, { recursive: true }),
  ]);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
