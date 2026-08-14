import { ERROR_CODES, StorageError } from "../shared/errors.js";
import { atomicWriteJson, readJsonFile, storagePaths } from "./fs-utils.js";

/**
 * Per-assessment VAPT configuration (scope + profile), stored under
 * `config/vapt/<assessmentId>.json` per the Phase 3 storage mapping.
 *
 * The scope payload is validated by the vapt scope module (`parseScope`);
 * this store only persists and reads it opaquely, following the Phase 2
 * store patterns (atomic writes, safe ids, tagged errors). Assessment ids
 * are treated as untrusted input and validated before use in any path.
 */
export type VaptStoredConfig = {
  assessmentId: string;
  scopeVersion: number;
  updatedAt: string;
  /** Validated scope object (see src/vapt/scope). Null = never scoped. */
  scope: unknown;
};

export interface VaptConfigStore {
  load(assessmentId: string): Promise<VaptStoredConfig | null>;
  save(config: VaptStoredConfig): Promise<void>;
}

export function createVaptConfigStore(root: string): VaptConfigStore {
  const paths = storagePaths(root);
  return {
    async load(assessmentId) {
      const file = paths.vaptConfig(assessmentId);
      const data = await readJsonFile<Record<string, unknown>>(file);
      if (data === null) return null;
      if (typeof data.assessmentId !== "string" || typeof data.scopeVersion !== "number") {
        throw new StorageError(
          ERROR_CODES.STORAGE_CORRUPT,
          `Invalid VAPT configuration in ${file}: expected fields "assessmentId" and "scopeVersion". Fix or remove the file and retry.`,
        );
      }
      return {
        assessmentId: data.assessmentId,
        scopeVersion: data.scopeVersion,
        updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
        scope: data.scope ?? null,
      };
    },
    async save(config) {
      await atomicWriteJson(paths.vaptConfig(config.assessmentId), {
        assessmentId: config.assessmentId,
        scopeVersion: config.scopeVersion,
        updatedAt: config.updatedAt,
        scope: config.scope,
      });
    },
  };
}
