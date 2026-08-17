import { promises as fs } from "node:fs";
import path from "node:path";
import type { SourceKind } from "../evidence/types.js";
import type { CollectedFile, FileCollector } from "./types.js";

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

/** Directories never descended into (preserved from the original scanner). */
export const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
]);

/** Classify a file path into a SourceKind, or null when unsupported. */
export function classifyFile(filePath: string): SourceKind | null {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (base.startsWith(".env") || CONFIG_EXTS.has(ext)) return "CONFIG";
  if (DOC_EXTS.has(ext)) return "DOCUMENT";
  if (CODE_EXTS.has(ext)) return "CODE";
  return null;
}

/**
 * Discovers files under a target directory (read-only, never follows
 * symlinks). Unreadable directories are skipped, matching the original
 * scanner's tolerant discovery behavior.
 */
export class FilesystemCollector implements FileCollector {
  private readonly ignoreDirs: ReadonlySet<string>;

  constructor(ignoreDirs: ReadonlySet<string> = DEFAULT_IGNORE_DIRS) {
    this.ignoreDirs = ignoreDirs;
  }

  async collect(targetPath: string): Promise<CollectedFile[]> {
    const root = path.resolve(targetPath);
    const files: CollectedFile[] = [];
    await this.walk(root, targetPath, files);
    return files;
  }

  private async walk(dir: string, root: string, out: CollectedFile[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip silently (preserved behavior)
    }
    for (const entry of entries) {
      if (this.ignoreDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(full, root, out);
      } else if (entry.isFile()) {
        const kind = classifyFile(full);
        if (!kind) continue;
        out.push({
          absolutePath: full,
          relativePath: path.relative(root, full).split(path.sep).join("/"),
          kind,
        });
      }
    }
  }
}
