import os from "node:os";
import path from "node:path";
import {
  createConfigStore,
  type ConfigStore,
} from "./config-store.js";
import {
  createCredentialStore,
  type CredentialStore,
} from "./credential-store.js";
import {
  createEvidenceStore,
  type EvidenceStore,
} from "./evidence-store.js";
import {
  createScanStateStore,
  type ScanStateStore,
} from "./scan-state-store.js";
import {
  createVaptConfigStore,
  type VaptConfigStore,
} from "./vapt-config-store.js";
import { ensureStorage } from "./schema.js";

/**
 * Composition root for local storage. Small, focused stores — deliberately
 * NOT a giant StorageManager: each store owns one responsibility and the
 * rest of the application never touches physical files directly.
 */
export type Storage = {
  config: ConfigStore;
  credentials: CredentialStore;
  scans: ScanStateStore;
  evidence: EvidenceStore;
  /** Per-assessment VAPT configuration (scope/profile). */
  vaptConfig: VaptConfigStore;
};

/**
 * Default storage root. Computed lazily so an override of `HOME` /
 * `USERPROFILE` (e.g. in tests) takes effect — never evaluated once at
 * module load. `os.homedir()` ignores `HOME` on Windows, so we read it
 * ourselves first.
 */
export function defaultStorageRoot(): string {
  const home =
    process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".dpdp");
}

/**
 * Open local storage at `root` (default `~/.dpdp`), initializing or
 * migrating it as needed, and return the store abstractions.
 */
export async function openStorage(root: string = defaultStorageRoot()): Promise<Storage> {
  await ensureStorage(root);
  return {
    config: createConfigStore(root),
    credentials: createCredentialStore(root),
    scans: createScanStateStore(root),
    evidence: createEvidenceStore(root),
    vaptConfig: createVaptConfigStore(root),
  };
}
