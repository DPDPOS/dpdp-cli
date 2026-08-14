import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { ERROR_CODES, StorageError } from "../shared/errors.js";
import { assertSafeId, atomicWriteJson, readJsonFile, storagePaths } from "./fs-utils.js";

/**
 * Assessment/scan runtime state. Kept intentionally small and extensible:
 * future capability types (e.g. VAPT) can add their own state shapes without
 * a giant shared state object. Scan ids are safe, unique identifiers; they
 * are validated before use in any artifact path.
 */
/**
 * DPDP statuses (scanned/job_created/submitted/failed) plus the VAPT scan
 * lifecycle (queued/running/completed/cancelled). Widening the union is
 * backward compatible: existing DPDP scan states keep their statuses.
 */
export type ScanStatus =
  | "scanned"
  | "job_created"
  | "submitted"
  | "failed"
  | "queued"
  | "running"
  | "completed"
  | "cancelled";
export type SubmissionState = "pending" | "submitted" | "failed";

export type ScanState = {
  scanId: string;
  assessmentId: string;
  scanJobId?: string;
  targetType?: string;
  targetPath?: string;
  status: ScanStatus;
  timestamps: {
    scannedAt?: string;
    submittedAt?: string;
  };
  submission?: {
    state: SubmissionState;
    submittedAt?: string;
    error?: string;
  };
  /** Associated evidence artifact, relative to the storage root. */
  evidenceFile?: string;
  /**
   * Capability that created this scan; omitted for DPDP scans (backward
   * compatible, no migration required).
   */
  capability?: "DPDP" | "VAPT";
  /**
   * Capability-specific execution state, stored opaquely and owned by the
   * capability module (e.g. src/vapt/engine for VAPT scans).
   */
  extra?: Record<string, unknown>;
};

export type CreateScanInput = {
  assessmentId: string;
  targetType?: string;
  targetPath?: string;
  capability?: "DPDP" | "VAPT";
  /** Override the initial status (default "scanned" for DPDP scans). */
  status?: ScanStatus;
  extra?: Record<string, unknown>;
};

export type ScanStatePatch = Partial<Omit<ScanState, "scanId">>;

export interface ScanStateStore {
  /** Creates a new scan state (generates the scan id) and persists it. */
  create(input: CreateScanInput): Promise<ScanState>;
  get(scanId: string): Promise<ScanState | null>;
  update(scanId: string, patch: ScanStatePatch): Promise<ScanState>;
  list(): Promise<ScanState[]>;
  getCurrentScanId(): Promise<string | null>;
  setCurrentScanId(scanId: string): Promise<void>;
  /** Convenience: state of the current scan, or null. */
  getCurrent(): Promise<ScanState | null>;
}

export function newScanId(): string {
  return `scan-${randomUUID()}`;
}

export function createScanStateStore(root: string): ScanStateStore {
  const paths = storagePaths(root);

  const get = async (scanId: string): Promise<ScanState | null> => {
    const data = await readJsonFile<Record<string, unknown>>(paths.scanState(scanId));
    if (data === null) return null;
    return validateScanState(data, paths.scanState(scanId));
  };

  const getCurrentScanId = async (): Promise<string | null> => {
    const data = await readJsonFile<{ scanId?: unknown }>(paths.currentScan);
    if (data === null) return null;
    if (typeof data.scanId !== "string") {
      throw new StorageError(
        ERROR_CODES.STORAGE_CORRUPT,
        `Invalid ${paths.currentScan}: expected string field "scanId". Fix or remove the file and retry.`,
      );
    }
    return data.scanId;
  };

  return {
    async create(input) {
      const scanId = newScanId();
      const state = compactScanState({
        scanId,
        assessmentId: input.assessmentId,
        status: input.status ?? "scanned",
        timestamps: { scannedAt: new Date().toISOString() },
        targetType: input.targetType,
        targetPath: input.targetPath,
        evidenceFile: `evidence/${scanId}.json`,
        capability: input.capability,
        extra: input.extra,
      });
      await atomicWriteJson(paths.scanState(scanId), state);
      return state;
    },
    get,
    async update(scanId, patch) {
      const current = await get(scanId);
      if (!current) {
        throw new StorageError(
          ERROR_CODES.STORAGE_CORRUPT,
          `No scan state found for ${scanId} (${paths.scanState(scanId)}).`,
        );
      }
      const merged: ScanState = {
        ...current,
        ...patch,
        scanId: current.scanId,
        timestamps: { ...current.timestamps, ...patch.timestamps },
      };
      const result = compactScanState(merged);
      await atomicWriteJson(paths.scanState(scanId), result);
      return result;
    },
    async list() {
      let names: string[];
      try {
        names = await fs.readdir(paths.scansDir);
      } catch {
        return [];
      }
      const states: ScanState[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const state = await get(name.slice(0, -".json".length));
        if (state) states.push(state);
      }
      return states;
    },
    getCurrentScanId,
    async setCurrentScanId(scanId) {
      assertSafeId(scanId, "scan id");
      await atomicWriteJson(paths.currentScan, { scanId });
    },
    async getCurrent() {
      const scanId = await getCurrentScanId();
      return scanId ? get(scanId) : null;
    },
  };
}

function validateScanState(
  data: Record<string, unknown>,
  file: string,
): ScanState {
  if (
    typeof data.scanId !== "string" ||
    typeof data.assessmentId !== "string" ||
    typeof data.status !== "string"
  ) {
    throw new StorageError(
      ERROR_CODES.STORAGE_CORRUPT,
      `Invalid scan state in ${file}. Fix or remove the file and retry.`,
    );
  }
  const timestamps =
    typeof data.timestamps === "object" && data.timestamps !== null
      ? (data.timestamps as Record<string, unknown>)
      : {};
  const submission =
    typeof data.submission === "object" && data.submission !== null
      ? (data.submission as ScanState["submission"])
      : undefined;
  return compactScanState({
    scanId: data.scanId,
    assessmentId: data.assessmentId,
    scanJobId: typeof data.scanJobId === "string" ? data.scanJobId : undefined,
    targetType: typeof data.targetType === "string" ? data.targetType : undefined,
    targetPath: typeof data.targetPath === "string" ? data.targetPath : undefined,
    status: data.status as ScanStatus,
    timestamps: {
      scannedAt: typeof timestamps.scannedAt === "string" ? timestamps.scannedAt : undefined,
      submittedAt:
        typeof timestamps.submittedAt === "string" ? timestamps.submittedAt : undefined,
    },
    submission,
    evidenceFile: typeof data.evidenceFile === "string" ? data.evidenceFile : undefined,
    capability:
      data.capability === "DPDP" || data.capability === "VAPT" ? data.capability : undefined,
    extra:
      typeof data.extra === "object" && data.extra !== null
        ? (data.extra as Record<string, unknown>)
        : undefined,
  });
}

/**
 * Strip undefined fields so every ScanState produced by the store has the
 * same shape on disk and in memory (JSON cannot represent undefined).
 */
function compactScanState(state: ScanState): ScanState {
  const result: ScanState = {
    scanId: state.scanId,
    assessmentId: state.assessmentId,
    status: state.status,
    timestamps: {},
  };
  if (state.scanJobId !== undefined) result.scanJobId = state.scanJobId;
  if (state.targetType !== undefined) result.targetType = state.targetType;
  if (state.targetPath !== undefined) result.targetPath = state.targetPath;
  if (state.timestamps.scannedAt !== undefined) result.timestamps.scannedAt = state.timestamps.scannedAt;
  if (state.timestamps.submittedAt !== undefined) result.timestamps.submittedAt = state.timestamps.submittedAt;
  if (state.submission !== undefined) result.submission = state.submission;
  if (state.evidenceFile !== undefined) result.evidenceFile = state.evidenceFile;
  if (state.capability !== undefined) result.capability = state.capability;
  if (state.extra !== undefined) result.extra = state.extra;
  return result;
}
