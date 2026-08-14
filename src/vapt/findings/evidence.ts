import type { Storage } from "../../storage/index.js";
import type { EvidenceItem, VaptFinding } from "./types.js";

export type LoadedVaptEvidence = {
  scanId: string;
  vaptFindings: VaptFinding[];
  evidence: EvidenceItem[];
};

/**
 * Load a VAPT evidence artifact from the shared EvidenceStore and narrow it
 * to the VAPT envelope. Returns null when the scan has no VAPT evidence.
 */
export async function loadVaptEvidence(
  storage: Storage,
  scanId: string,
): Promise<LoadedVaptEvidence | null> {
  const stored = await storage.evidence.load(scanId);
  if (!stored || stored.capability !== "VAPT") return null;
  return {
    scanId,
    vaptFindings: stored.vaptFindings ?? [],
    evidence: stored.evidence ?? [],
  };
}

/**
 * Id of the most recent VAPT scan (by creation timestamp). VAPT deliberately
 * does not use the shared `state/current-scan.json` pointer — that pointer
 * stays DPDP-owned so `dpdp evidence`/`submit` never see VAPT data.
 */
export async function latestVaptScanId(storage: Storage): Promise<string | null> {
  const states = (await storage.scans.list()).filter((s) => s.capability === "VAPT");
  if (states.length === 0) return null;
  states.sort((a, b) =>
    (b.timestamps.scannedAt ?? "").localeCompare(a.timestamps.scannedAt ?? ""),
  );
  return states[0]!.scanId;
}
