import type { ScanContext } from "../../../core/scanner/scan-context.js";
import type { RawFinding, SourceKind } from "../../../evidence/types.js";
import type { Analyzer } from "../../analyzer.js";
import { PATTERNS, type Pattern } from "./patterns.js";

const ALL_KINDS: readonly SourceKind[] = ["CODE", "CONFIG", "DOCUMENT"];

/**
 * The original regex scanner, now one analyzer in the new architecture.
 *
 * Applies every pattern whose `applicableKinds` include the file's kind.
 * Produces raw findings; the pipeline stamps sourceType/sourceHash.
 */
export class RegexAnalyzer implements Analyzer {
  readonly id = "regex-source";
  readonly name = "Regex Source Analyzer";
  readonly supportedKinds = [...ALL_KINDS];

  private readonly patterns: readonly Pattern[];

  constructor(patterns: readonly Pattern[] = PATTERNS) {
    this.patterns = patterns;
  }

  analyze(context: ScanContext): RawFinding[] {
    const findings: RawFinding[] = [];
    const lines = context.content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const pattern of this.patterns) {
        if (!pattern.applicableKinds.includes(context.kind)) continue;
        if (!pattern.re.test(line)) continue;
        findings.push({
          findingType: pattern.findingType,
          location: `${context.relativePath}:${i + 1}`,
          excerpt: line.trim().slice(0, 300),
          confidence: 0.85,
          controlCandidates: pattern.controls,
        });
      }
    }
    return findings;
  }
}
