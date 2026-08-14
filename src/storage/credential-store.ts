import { ERROR_CODES, StorageError } from "../shared/errors.js";
import { atomicWriteJson, readJsonFile, storagePaths } from "./fs-utils.js";

/**
 * Dedicated credential storage. The bearer token never shares a file with
 * configuration, state or evidence, and is never printed in output, logs or
 * errors (commands/transport pass it around explicitly).
 */
export type Credentials = {
  token: string;
};

export interface CredentialStore {
  /** Returns null when no credentials have been saved. */
  load(): Promise<Credentials | null>;
  save(credentials: Credentials): Promise<void>;
}

/** Owner read/write. No-op on platforms without Unix-style permissions. */
export const CREDENTIALS_FILE_MODE = 0o600;

export function createCredentialStore(root: string): CredentialStore {
  const paths = storagePaths(root);
  return {
    async load() {
      const data = await readJsonFile<Record<string, unknown>>(paths.credentials);
      if (data === null) return null;
      if (typeof data.token !== "string") {
        throw new StorageError(
          ERROR_CODES.STORAGE_CORRUPT,
          `Invalid credentials in ${paths.credentials}: expected string field "token". Fix or remove the file and retry.`,
        );
      }
      return { token: data.token };
    },
    async save(credentials) {
      // The temporary file inherits the restrictive mode, so credentials are
      // never world-readable even mid-write.
      await atomicWriteJson(paths.credentials, { token: credentials.token }, { mode: CREDENTIALS_FILE_MODE });
    },
  };
}
