import { ERROR_CODES, StorageError } from "../shared/errors.js";
import { atomicWriteJson, readJsonFile, storagePaths } from "./fs-utils.js";

/**
 * Stable CLI configuration. Deliberately free of scan results, evidence or
 * credentials — those live in their own stores.
 */
export type AppConfig = {
  apiBaseUrl: string;
  assessmentId: string;
};

export interface ConfigStore {
  /** Returns null when the CLI has never been configured. */
  load(): Promise<AppConfig | null>;
  save(config: AppConfig): Promise<void>;
}

export function createConfigStore(root: string): ConfigStore {
  const paths = storagePaths(root);
  return {
    async load() {
      const data = await readJsonFile<Record<string, unknown>>(paths.config);
      if (data === null) return null;
      if (typeof data.apiBaseUrl !== "string" || typeof data.assessmentId !== "string") {
        throw new StorageError(
          ERROR_CODES.STORAGE_CORRUPT,
          `Invalid configuration in ${paths.config}: expected string fields "apiBaseUrl" and "assessmentId". Fix or remove the file and retry.`,
        );
      }
      return { apiBaseUrl: data.apiBaseUrl, assessmentId: data.assessmentId };
    },
    async save(config) {
      await atomicWriteJson(paths.config, {
        apiBaseUrl: config.apiBaseUrl,
        assessmentId: config.assessmentId,
      });
    },
  };
}
