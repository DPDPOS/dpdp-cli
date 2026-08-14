import { promises as fs } from "node:fs";
import { EVIDENCE_SCHEMA_VERSION, type Finding } from "../evidence/types.js";
import {
  VAPT_EVIDENCE_SCHEMA_VERSION,
  type EvidenceItem,
  type VaptFinding,
} from "../vapt/findings/types.js";
import { ERROR_CODES, StorageError } from "../shared/errors.js";
import { atomicWriteJson, assertSafeId, readJsonFile, storagePaths } from "./fs-utils.js";

/**
 * Evidence artifacts are stored per scan (keyed by the safe scan id), so
 * multiple scans never overwrite each other, evidence survives failed
 * submissions, and it can be retrieved offline by scan identity.
 *
 * The envelope is capability-tagged: DPDP artifacts use `findings` with
 * schemaVersion 1; VAPT artifacts use `vaptFindings`/`evidence` with
 * schemaVersion 2. The two families are versioned separately (Phase 3
 * design) and existing DPDP evidence is untouched.
 */
export type StoredEvidence = {
  scanId: string;
  schemaVersion: number;
  /** Capability that produced this artifact; omitted for DPDP evidence. */
  capability?: "DPDP" | "VAPT";
  /** DPDP findings (empty for VAPT artifacts). */
  findings: Finding[];
  /** VAPT findings — present when capability === "VAPT". */
  vaptFindings?: VaptFinding[];
  /** VAPT evidence items — present when capability === "VAPT". */
  evidence?: EvidenceItem[];
};

export type EvidenceEnvelope =
  | { schemaVersion: typeof EVIDENCE_SCHEMA_VERSION; findings: Finding[] }
  | {
      capability: "VAPT";
      schemaVersion: typeof VAPT_EVIDENCE_SCHEMA_VERSION;
      vaptFindings: VaptFinding[];
      evidence: EvidenceItem[];
    };

export interface EvidenceStore {
  save(scanId: string, bundle: EvidenceEnvelope): Promise<void>;
  load(scanId: string): Promise<StoredEvidence | null>;
  exists(scanId: string): Promise<boolean>;
}

export function createEvidenceStore(root: string): EvidenceStore {
  const paths = storagePaths(root);
  return {
    async save(scanId, bundle) {
      assertSafeId(scanId, "scan id");
      await atomicWriteJson(paths.evidence(scanId), {
        scanId,
        findings: "findings" in bundle ? bundle.findings : [],
        ...bundle,
      });
    },
    async load(scanId) {
      const data = await readJsonFile<Record<string, unknown>>(paths.evidence(scanId));
      if (data === null) return null;
      if (
        typeof data.scanId !== "string" ||
        !Array.isArray(data.findings) ||
        typeof data.schemaVersion !== "number"
      ) {
        throw new StorageError(
          ERROR_CODES.STORAGE_CORRUPT,
          `Invalid evidence in ${paths.evidence(scanId)}. Fix or remove the file and retry.`,
        );
      }
      return {
        scanId: data.scanId,
        schemaVersion: data.schemaVersion,
        capability: data.capability === "VAPT" ? "VAPT" : undefined,
        findings: data.findings as Finding[],
        vaptFindings:
          Array.isArray(data.vaptFindings) ? (data.vaptFindings as VaptFinding[]) : undefined,
        evidence: Array.isArray(data.evidence) ? (data.evidence as EvidenceItem[]) : undefined,
      };
    },
    async exists(scanId) {
      try {
        await fs.access(paths.evidence(scanId));
        return true;
      } catch {
        return false;
      }
    },
  };
}
