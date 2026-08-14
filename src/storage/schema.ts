import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { EVIDENCE_SCHEMA_VERSION, type Finding } from "../evidence/types.js";
import { ERROR_CODES, StorageError } from "../shared/errors.js";
import {
  atomicWriteJson,
  ensureDirs,
  readJsonFile,
  type StoragePaths,
  storagePaths,
} from "./fs-utils.js";

/**
 * Current local-storage schema version.
 *
 * Version handling is centralized here: `ensureStorage` detects the version
 * of a storage root, migrates older versions forward (idempotently), and
 * rejects unsupported future versions. CLI commands never run migrations
 * themselves.
 */
export const STORAGE_SCHEMA_VERSION = 2;

type SchemaFile = { schemaVersion?: unknown };

/** Shape of the legacy (Phase 1 / v1) single-file `~/.dpdp/config.json`. */
type LegacyConfig = {
  apiBaseUrl?: string;
  token?: string;
  assessmentId?: string;
  lastScanJobId?: string;
  lastFindings?: Finding[];
};

/**
 * Open (and if needed, initialize/migrate) the storage at `root`.
 *
 * - No `schema.json` + legacy `config.json` present → v1 legacy storage.
 * - No `schema.json` + no legacy config → fresh storage.
 * - `schema.json` with an older version → migrate forward.
 * - `schema.json` with a newer version → reject with a clear error.
 */
export async function ensureStorage(root: string): Promise<void> {
  const paths = storagePaths(root);
  const schema = await readJsonFile<SchemaFile>(paths.schema);

  let version: number | null;
  if (schema === null) {
    version = (await legacyConfigExists(paths)) ? 1 : null;
  } else {
    if (typeof schema.schemaVersion !== "number") {
      throw new StorageError(
        ERROR_CODES.STORAGE_CORRUPT,
        `Invalid ${paths.schema}: expected a numeric "schemaVersion". Fix or remove the file and retry.`,
      );
    }
    version = schema.schemaVersion;
  }

  if (version === null) {
    // Fresh storage.
    await ensureDirs(root);
    await writeSchemaMarker(paths);
    return;
  }

  if (version > STORAGE_SCHEMA_VERSION) {
    throw new StorageError(
      ERROR_CODES.STORAGE_SCHEMA,
      `Unsupported storage schema version ${version} (this CLI supports up to ${STORAGE_SCHEMA_VERSION}). ` +
        `Upgrade the dpdp CLI to use this storage.`,
    );
  }

  if (version < STORAGE_SCHEMA_VERSION) {
    await migrateV1ToV2(root, paths);
    return;
  }

  await ensureDirs(root);
}

async function writeSchemaMarker(paths: StoragePaths): Promise<void> {
  await atomicWriteJson(paths.schema, { schemaVersion: STORAGE_SCHEMA_VERSION });
}

async function legacyConfigExists(paths: StoragePaths): Promise<boolean> {
  try {
    await fs.access(paths.legacyConfig);
    return true;
  } catch {
    return false;
  }
}

/**
 * v1 → v2 migration: split the legacy single-file config into
 * configuration, credentials, scan state and evidence artifacts.
 *
 * Guarantees:
 * - Non-destructive: the legacy file is left untouched.
 * - Idempotent: the scan id is derived deterministically from the legacy
 *   data, so re-running (e.g. after a partial failure) rewrites the same
 *   files. The `schema.json` marker is written LAST as the commit point.
 * - Never silently drops: token, apiBaseUrl, assessmentId, lastScanJobId,
 *   lastFindings.
 */
async function migrateV1ToV2(root: string, paths: StoragePaths): Promise<void> {
  const legacy = await readLegacyConfig(paths);

  await ensureDirs(root);

  if (legacy !== null) {
    // Stable configuration.
    await atomicWriteJson(paths.config, {
      apiBaseUrl: legacy.apiBaseUrl ?? "",
      assessmentId: legacy.assessmentId ?? "",
    });

    // Credentials, owner-only where the platform supports it.
    await atomicWriteJson(paths.credentials, { token: legacy.token ?? "" }, { mode: 0o600 });

    // The last scan (if any): preserve job id + findings so the user can
    // still run `dpdp evidence` and retry `dpdp submit` without rescanning.
    if (legacy.lastScanJobId !== undefined || legacy.lastFindings !== undefined) {
      const scanId = deriveScanId(legacy.lastScanJobId, legacy.lastFindings);
      await atomicWriteJson(paths.scanState(scanId), {
        scanId,
        assessmentId: legacy.assessmentId ?? "",
        scanJobId: legacy.lastScanJobId,
        status: legacy.lastScanJobId ? "job_created" : "scanned",
        timestamps: {},
        submission: legacy.lastScanJobId ? { state: "pending" } : undefined,
        evidenceFile: `evidence/${scanId}.json`,
      });
      if (legacy.lastFindings !== undefined) {
        await atomicWriteJson(paths.evidence(scanId), {
          scanId,
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          findings: legacy.lastFindings,
        });
      }
      await atomicWriteJson(paths.currentScan, { scanId });
    }
  }

  // Commit marker last: migration is only considered complete once every
  // data file above has been written.
  await writeSchemaMarker(paths);
}

async function readLegacyConfig(paths: StoragePaths): Promise<LegacyConfig | null> {
  const data = await readJsonFile<Record<string, unknown>>(paths.legacyConfig);
  if (data === null) return null;
  return {
    apiBaseUrl: typeof data.apiBaseUrl === "string" ? data.apiBaseUrl : undefined,
    token: typeof data.token === "string" ? data.token : undefined,
    assessmentId: typeof data.assessmentId === "string" ? data.assessmentId : undefined,
    lastScanJobId: typeof data.lastScanJobId === "string" ? data.lastScanJobId : undefined,
    lastFindings: Array.isArray(data.lastFindings)
      ? (data.lastFindings as Finding[])
      : undefined,
  };
}

/**
 * Deterministic scan id for migrated scans, so migration is idempotent even
 * if it is re-run after a partial failure.
 */
function deriveScanId(
  lastScanJobId: string | undefined,
  lastFindings: Finding[] | undefined,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        lastScanJobId: lastScanJobId ?? null,
        lastFindings: lastFindings ?? null,
      }),
    )
    .digest("hex");
  return `scan-${digest.slice(0, 16)}`;
}
