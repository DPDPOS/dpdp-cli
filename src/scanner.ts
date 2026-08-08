import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type Finding = {
  sourceType: "CODE" | "CONFIG" | "DOCUMENT";
  location: string;
  findingType: string;
  excerpt?: string;
  confidence: number;
  controlCandidates: string[];
  sourceHash?: string;
};

const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".java",
  ".rb",
  ".php",
  ".cs",
]);
const CONFIG_EXTS = new Set([
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".env",
  ".ini",
  ".conf",
]);
const DOC_EXTS = new Set([".md", ".txt", ".rst"]);

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
]);

type Pattern = {
  re: RegExp;
  findingType: string;
  controls: string[];
  sourceType: Finding["sourceType"];
};

const PATTERNS: Pattern[] = [
  {
    re: /consent/i,
    findingType: "consent_reference",
    controls: ["DPDP-CONSENT-COLLECT", "DPDP-CONSENT-NOTICE"],
    sourceType: "CODE",
  },
  {
    re: /withdraw.*consent|consent.*withdraw/i,
    findingType: "consent_withdrawal",
    controls: ["DPDP-CONSENT-WITHDRAW"],
    sourceType: "CODE",
  },
  {
    re: /(router|app)\.(delete|del)\(['"`].*(account|user|personal|data)/i,
    findingType: "deletion_endpoint",
    controls: ["DPDP-RIGHTS-ERASURE"],
    sourceType: "CODE",
  },
  {
    re: /(erase|erasure|right.?to.?be.?forgotten)/i,
    findingType: "erasure_logic",
    controls: ["DPDP-RIGHTS-ERASURE"],
    sourceType: "CODE",
  },
  {
    re: /(access.?request|data.?export|\/me\/data)/i,
    findingType: "access_endpoint",
    controls: ["DPDP-RIGHTS-ACCESS"],
    sourceType: "CODE",
  },
  {
    re: /grievance/i,
    findingType: "grievance_reference",
    controls: ["DPDP-RIGHTS-GRIEVANCE"],
    sourceType: "CODE",
  },
  {
    re: /(breach|incident.?response)/i,
    findingType: "breach_reference",
    controls: ["DPDP-BREACH-DETECT", "DPDP-BREACH-NOTIFY"],
    sourceType: "CODE",
  },
  {
    re: /retention/i,
    findingType: "retention_reference",
    controls: ["DPDP-RETENTION-SCHEDULE", "DPDP-RETENTION-LOGS"],
    sourceType: "CODE",
  },
  {
    re: /(LOG_RETENTION|RETENTION_DAYS|DATA_RETENTION)/i,
    findingType: "retention_config",
    controls: ["DPDP-RETENTION-LOGS", "DPDP-RETENTION-SCHEDULE"],
    sourceType: "CONFIG",
  },
  {
    re: /(privacy.?policy|notice)/i,
    findingType: "notice_language",
    controls: ["DPDP-CONSENT-NOTICE"],
    sourceType: "DOCUMENT",
  },
  {
    re: /(processor|subprocessor|data.?processing.?agreement|\bDPA\b)/i,
    findingType: "vendor_reference",
    controls: ["DPDP-VENDOR-INVENTORY", "DPDP-VENDOR-DPA"],
    sourceType: "DOCUMENT",
  },
];

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function classify(filePath: string): Finding["sourceType"] | null {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (base.startsWith(".env") || CONFIG_EXTS.has(ext)) return "CONFIG";
  if (DOC_EXTS.has(ext)) return "DOCUMENT";
  if (CODE_EXTS.has(ext)) return "CODE";
  return null;
}

export async function scanDirectory(root: string): Promise<Finding[]> {
  const files = await walk(path.resolve(root));
  const findings: Finding[] = [];

  for (const file of files) {
    const kind = classify(file);
    if (!kind) continue;
    let content: string;
    try {
      const buf = await fs.readFile(file);
      if (buf.length > 1_500_000) continue;
      content = buf.toString("utf8");
    } catch {
      continue;
    }

    const rel = path.relative(root, file);
    const hash = createHash("sha256").update(content).digest("hex");
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const pattern of PATTERNS) {
        if (pattern.sourceType !== kind && pattern.sourceType !== "DOCUMENT") {
          // allow code patterns on config too when useful
          if (!(kind === "CONFIG" && pattern.sourceType === "CODE")) {
            if (kind !== pattern.sourceType) continue;
          }
        }
        if (!pattern.re.test(line)) continue;
        findings.push({
          sourceType: kind,
          location: `${rel}:${i + 1}`,
          findingType: pattern.findingType,
          excerpt: line.trim().slice(0, 300),
          confidence: 0.85,
          controlCandidates: pattern.controls,
          sourceHash: hash,
        });
      }
    }
  }

  // Deduplicate by location+findingType
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.location}|${f.findingType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
