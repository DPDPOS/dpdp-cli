# Phase 1 Handoff Report — DPDPOS CLI Refactor

**Objective:** Same working CLI, refactored into a stable evidence-collection platform with clear extension points. The regex scanner becomes one analyzer inside a small pipeline; no backend/CLI contract changes.

---

## 1. Summary of changes

- Split the monolithic `src/index.ts` + `src/scanner.ts` into a layered structure:
  `cli` → `core` → `analyzers` / `collectors` / `evidence` / `transport` / `storage` / `shared`.
- Introduced a small **Analyzer** interface (`id`, `name`, `supportedKinds`, `analyze(context)`).
- The existing regex implementation is now the **RegexAnalyzer** (`id: "regex-source"`).
- Introduced a **ScannerEngine** that orchestrates: discover → classify → `ScanContext` → run analyzers → normalize → deduplicate → `EvidenceBundle`.
- Introduced an internal **AnalyzerRegistry**; production wiring lives in a **default profile** (`src/core/profiles/default.ts`).
- Replaced the implicit pattern/sourceType matching matrix with explicit **`applicableKinds`** per rule (behavior change, see §11/§17/§18).
- Moved `Finding` into a dedicated evidence module with backward-compatible **`schemaVersion`** on the internal `EvidenceBundle` only (backend payload unchanged).
- Moved config storage (`~/.dpdp/config.json`) and the HTTP client out of `index.ts` **verbatim**.
- Moved each CLI command into `src/cli/commands/`; `src/index.ts` is now an 8-line bootstrap.
- Added tests (Node built-in `node:test` via `tsx`, no new dependencies) — 33 tests across 9 areas.
- Hygiene: `.gitignore` already renamed from `,gitignore` (verified: current repo has `.gitignore` with `node_modules/`, `,gitignore` is gone from history's working tree and no `,gitignore` file exists); added `dist/` to `.gitignore`.

## 2. Complete final folder structure

```
src/
├── index.ts                        # thin bootstrap: buildProgram().parseAsync(argv)
├── cli/
│   ├── program.ts                  # buildProgram(): assembles all commands (Commander only here)
│   └── commands/
│       ├── init.ts                 # dpdp init
│       ├── login.ts                # dpdp login
│       ├── configure.ts            # dpdp configure
│       ├── scan.ts                 # dpdp scan  (uses core/profile scanner)
│       ├── evidence.ts             # dpdp evidence
│       ├── submit.ts               # dpdp submit
│       ├── status.ts               # dpdp status
│       ├── rescan.ts               # dpdp rescan (calls scan + submit actions directly)
│       └── report.ts               # dpdp report
├── core/
│   ├── scanner/
│   │   ├── scanner-engine.ts       # pipeline orchestration (no detection rules)
│   │   ├── scan-context.ts         # read-only ScanContext type + factory (read + sha256)
│   │   └── analyzer-registry.ts    # AnalyzerRegistry
│   └── profiles/
│       └── default.ts              # createDefaultScanner(): composition root (registry + RegexAnalyzer + FilesystemCollector)
├── analyzers/
│   ├── analyzer.ts                 # Analyzer interface
│   └── source/
│       └── regex/
│           ├── patterns.ts         # Pattern type + PATTERNS (explicit applicableKinds)
│           └── regex-analyzer.ts   # RegexAnalyzer (the original scanner)
├── collectors/
│   ├── types.ts                    # CollectedFile + FileCollector interface
│   └── filesystem.ts               # FilesystemCollector (walk + classifyFile)
├── evidence/
│   ├── types.ts                    # SourceKind, Finding, RawFinding, EvidenceBundle, EVIDENCE_SCHEMA_VERSION
│   ├── normalize.ts                # normalizeFinding(): stamps sourceType/sourceHash
│   └── deduplicate.ts              # deduplicate(): location+findingType
├── transport/
│   └── api.ts                      # HTTP client (unchanged)
├── storage/
│   └── config.ts                   # CliConfig, CONFIG_PATH, loadConfig/saveConfig (unchanged)
└── shared/
    └── errors.ts                   # ScanError taxonomy (file_read, analyzer) — no logging framework
```

No empty placeholder folders were created for future features.

## 3. Old → new file mapping

| Old file | New location(s) |
|---|---|
| `src/index.ts` (commands + config + api + bootstrap) | `src/cli/program.ts`, `src/cli/commands/*.ts` (9), `src/storage/config.ts`, `src/transport/api.ts`, `src/index.ts` (bootstrap only) |
| `src/scanner.ts` (deleted) | `src/collectors/filesystem.ts` (walk/ignore/classify), `src/analyzers/source/regex/patterns.ts` + `regex-analyzer.ts` (patterns/analysis), `src/core/scanner/scanner-engine.ts` (orchestration + size limit + dedup call), `src/evidence/*` (Finding, normalize, deduplicate) |

## 4. Scanner execution flow

```
dpdp scan <path> (cli/commands/scan.ts)
  └─ createDefaultScanner()            (core/profiles/default.ts)
       └─ ScannerEngine.scan(target)   (core/scanner/scanner-engine.ts)
            ├─ FilesystemCollector.collect(target)   → discover files (ignore dirs) + classify → CollectedFile[]
            ├─ createScanContext(file)               → read content, sha256, freeze → ScanContext
            ├─ (size > 1.5MB → skip silently, as before)
            ├─ for each analyzer of registry.forKind(kind):
            │     analyzer.analyze(context)          → RawFinding[]
            │     normalizeFinding(raw, context)     → Finding (stamps sourceType, sourceHash)
            ├─ deduplicate(findings)                 → location|findingType, first wins
            └─ EvidenceBundle { schemaVersion: 1, findings }  (+ non-fatal issues list)
  └─ persist findings to ~/.dpdp/config.json  →  POST /cli/scans  →  save job id
```

## 5. Analyzer interface

```ts
// src/analyzers/analyzer.ts
export interface Analyzer {
  readonly id: string;                                  // e.g. "regex-source"
  readonly name: string;                                // e.g. "Regex Source Analyzer"
  readonly supportedKinds: readonly SourceKind[];       // kinds this analyzer can interpret
  analyze(context: ScanContext): RawFinding[] | Promise<RawFinding[]>;
}
```

- Small, composable — no god interface. Sync or async implementations both work (engine awaits).
- Analyzers receive a read-only `ScanContext` and must never mutate customer files.

## 6. RegexAnalyzer implementation

- `src/analyzers/source/regex/regex-analyzer.ts` — class implementing `Analyzer` with `id = "regex-source"`, `supportedKinds = ["CODE","CONFIG","DOCUMENT"]`.
- Iterates lines × patterns exactly like the original (`lines` outer, `patterns` inner, preserving output order). For each matching rule it emits a `RawFinding`:
  `{ findingType, location: `${relativePath}:${lineNo}`, excerpt: line.trim().slice(0,300), confidence: 0.85, controlCandidates }`.
- `patterns.ts` defines `Pattern` and `PATTERNS` — rule regexes, `findingType`, `controls` are byte-for-byte the original; the `sourceType` field was replaced with explicit `applicableKinds` (see §11).

## 7. ScanContext structure

```ts
// src/core/scanner/scan-context.ts
export type ScanContext = Readonly<{
  targetPath: string;    // absolute scan root
  absolutePath: string;  // absolute file path
  relativePath: string;  // relative to scan root (used in locations)
  kind: SourceKind;      // CODE | CONFIG | DOCUMENT
  content: string;       // UTF-8 content
  sourceHash: string;    // sha256 of the decoded content (same as before)
  sizeBytes: number;
}>;
```

- Frozen with `Object.freeze` at creation — the read-only guarantee is enforced at runtime, not just by type.
- `sourceHash` is computed over the **decoded string** exactly as the original did (verified identical hashes in before/after output).

## 8. Evidence model

`src/evidence/types.ts`:

```ts
export type SourceKind = "CODE" | "CONFIG" | "DOCUMENT";
export type Finding = {          // backend contract — unchanged
  sourceType: SourceKind;
  location: string;              // relative/path:line
  findingType: string;
  excerpt?: string;
  confidence: number;
  controlCandidates: string[];
  sourceHash?: string;
};
export type RawFinding = {       // pre-normalization analyzer output (no sourceType/sourceHash)
  findingType: string; location: string; excerpt?: string;
  confidence: number; controlCandidates: string[];
};
export type EvidenceBundle = { schemaVersion: 1; findings: Finding[] };
```

- `normalizeFinding(raw, context)` stamps `sourceType` (from file kind) and `sourceHash` (from context) onto raw analyzer output — the pipeline owns the Finding contract, not the analyzer.
- `deduplicate(findings)` keeps `location + findingType` keys, first occurrence wins, order preserved.

## 9. Evidence schema / versioning

- `EVIDENCE_SCHEMA_VERSION = 1` lives on the **internal `EvidenceBundle` envelope only**.
- It is deliberately **NOT** added to `Finding` records: the `findings` array is the backend payload, so adding a field there would change the backend contract (which is out of scope for Phase 1). `~/.dpdp/config.json` `lastFindings` and the submitted payload keep their exact prior shape. Tests assert `"schemaVersion" in finding === false`.
- Old config files remain readable: `loadConfig` is unchanged and new fields (`schemaVersion`) never touch stored findings.

## 10. Analyzer registry

`src/core/scanner/analyzer-registry.ts` — `AnalyzerRegistry` with `register` (throws on duplicate id), `unregister`, `get`, `list`, `forKind(kind)`. The engine only executes registered analyzers; registration happens in `core/profiles/default.ts`, so the engine never changes when analyzers are added. No plugin downloads, no DI framework.

## 11. Pattern applicability changes  ⚠ CHANGED

**Before (implicit matrix in `scanDirectory`):**

| pattern sourceType \ file kind | CODE | CONFIG | DOCUMENT |
|---|---|---|---|
| CODE | ✓ | ✓ | ✗ |
| CONFIG | ✗ | ✓ | ✗ |
| DOCUMENT | ✓ | ✓ | ✓ |

**After (explicit `applicableKinds`, per your decision — clean per-kind):**

| rule | applicableKinds |
|---|---|
| consent_reference, consent_withdrawal, deletion_endpoint, erasure_logic, access_endpoint, grievance_reference, breach_reference, retention_reference | `["CODE"]` |
| retention_config | `["CONFIG"]` |
| notice_language, vendor_reference | `["DOCUMENT"]` |

The confusing implicit behavior (DOCUMENT rules firing on CODE/CONFIG files; CODE rules firing on CONFIG files) is gone. Output differences are documented in §17.

## 12. Deduplication behavior

**PRESERVED exactly.** `deduplicate()` uses the same key `${location}|${findingType}`, same first-wins + order-preserving semantics, applied once at the end of the pipeline. The tests confirm two analyzers producing the same `location|findingType` collapse to one finding.

## 13. CLI command changes

**None to user-visible behavior.** All nine commands (`init`, `login`, `configure`, `scan`, `evidence`, `submit`, `status`, `rescan`, `report`) are registered identically in `src/cli/program.ts` with the same names, options, arguments, help text, output and error messages. Internal change only:
- `rescan` now calls the `scan`/`submit` **action functions directly** instead of re-invoking `program.parseAsync([...])` — same code paths, same output (verified).
- `scan` prints `scan warning: …` lines to **stderr** when the engine records non-fatal issues (unreadable file / analyzer failure). Previously these were swallowed silently. Only appears on error; stdout output is unchanged.

## 14. Backend compatibility confirmation

- **Endpoints unchanged:** `POST /api/v1/assessments/:id/cli/scans`, `POST /api/v1/assessments/:id/cli/evidence/batch`, `GET /api/v1/assessments/:id/cli/scans/:jobId`, `GET /api/v1/assessments/:id/report` — all identical strings.
- **Payload unchanged:** `submit` posts `{ scanJobId, findings }` with findings in the exact old shape (no `schemaVersion` on findings).
- **Auth unchanged:** `Authorization: Bearer <token>` and the optional `DPDP_USER_TOKEN` flow are byte-for-byte the original.
- **Local config unchanged:** `~/.dpdp/config.json` field names and semantics identical; old files read fine.

## 15. Tests added (33 tests, 9 suites)

| Area | File |
|---|---|
| 1. RegexAnalyzer behavior | `src/analyzers/source/regex/regex-analyzer.test.ts` |
| 2. Pattern applicability | same file (CODE/DOCUMENT/CONFIG-only assertions) |
| 3. File classification | `src/collectors/filesystem.test.ts` |
| 4. Directory ignore behavior | same file (node_modules/.git/dist ignore, custom ignore dirs) |
| 5. Deduplication | `src/evidence/deduplicate.test.ts` |
| 6. Evidence schema | `src/evidence/types.test.ts` |
| 7. Analyzer registry | `src/core/scanner/analyzer-registry.test.ts` |
| 8. Scanner pipeline | `src/core/scanner/scanner-engine.test.ts` (normalization, dedup across analyzers, unreadable-file tolerance, analyzer-failure tolerance, oversized skip) |
| 9. fixtures/sample-app end-to-end | same file (golden key set, contract spot checks) |

Runner: Node built-in `node:test` via `tsx --test "src/**/*.test.ts"` (`npm test`) — **zero new dependencies**.

## 16. Build / test results

- `rm -rf node_modules dist && npm install` → clean, 0 vulnerabilities.
- `npm run build` (tsc, strict) → **passes**.
- `npm test` → **33/33 pass**; test files also pass a standalone `tsc --noEmit` strict typecheck.
- `fixtures/sample-app` scans successfully (14 findings, 0 issues).
- All CLI commands verified against the built `dist/index.js` (help, init, login, configure, scan, evidence, submit, status, report, rescan, version) with a temp `HOME`.

## 17. Before/after scanner output comparison

Ran the original `scanDirectory` and the new engine on `fixtures/sample-app` in the same environment:

- **Before: 18 findings. After: 14 findings.**
- Removed (4) — all cross-kind, per the chosen applicability semantics:
  - `.env.example:1|retention_reference`, `.env.example:2|retention_reference` (CODE rule on CONFIG file)
  - `src/privacy.ts:13|notice_language`, `src/privacy.ts:16|vendor_reference` (DOCUMENT rules on CODE file)
- Added: none.
- On the 14 retained findings: **field-for-field identical** (location, excerpt, confidence, controlCandidates, sourceHash, sourceType) — 0 differences. Ordering within files is preserved (line × pattern iteration order kept).
- Backend/API behavior: the `submit` payload shape is unchanged; only the count/content of findings reflects the applicability fix.

## 18. Intentional behavior changes

1. **Pattern applicability** (user-approved): clean per-kind matching; removes the 4 cross-kind findings above. This is the only change to scanner *output*.
2. **Scan warnings on stderr**: non-fatal file-read/analyzer failures are now reported (`scan warning: …`) instead of silently ignored; scans still never abort on a single bad file.
3. **`rescan` implementation**: direct action calls instead of commander re-parsing (no observable difference).

Everything else is a move/rename with preserved behavior.

## 19. Migration risks

- **Finding count change** is the main one: any downstream dashboard/expectation keyed to the old 18 findings on this fixture will see 14. This was an explicit, user-approved decision; re-adding a rule for "notice language in code comments" later is a one-line `applicableKinds` addition, not a re-introduction of the implicit matrix.
- **Stderr warnings**: scripts parsing stdout are unaffected (warnings go to stderr), but anything capturing stderr will see new lines only when files are unreadable/analyzers fail.
- **Ordering across filesystems**: file iteration order depends on `readdir` (as before); the e2e test asserts the key *set*, not order, to stay portable.
- Compiled `dist/` now excludes tests (`tsconfig` exclude) — `npm run build` still typechecks all non-test code; tests are typechecked separately (verified) and run via `tsx`.

## 20. Remaining technical debt (unchanged by design — later phases)

- `~/.dpdp/config.json` has no validation, no schema migration, no atomic writes, and mixes credentials with state (deferred — explicitly out of scope).
- Evidence payload has no explicit version on the wire (deferred — would need backend coordination).
- Deduplication is in-memory per scan only; no cross-scan history.
- Regex detection rules are a flat array; no rule metadata beyond `applicableKinds`.
- No logging framework (intentional); only `scan warning:` stderr lines.

## 21. How a future analyzer/capability would be added

1. Create the analyzer under `src/analyzers/<domain>/…` implementing the `Analyzer` interface (it can return findings directly — `Collector → Analyzer → Evidence` — or, for non-file sources later, add a small collector under `src/collectors/` and feed the engine, keeping `Collector → Evidence` flows possible without touching the engine).
2. Register it in `src/core/profiles/default.ts` (or a new profile): `registry.register(new MyAnalyzer())`.
3. Add tests mirroring `regex-analyzer.test.ts` / `scanner-engine.test.ts`.
4. Done — no changes to `ScannerEngine`, `src/index.ts`, or the CLI command layer.

Example for a future dependency analyzer: `src/analyzers/dependency/manifest-analyzer.ts` with `supportedKinds: ["CONFIG"]`, registered in the profile; the engine picks it up for every CONFIG file automatically.

## 22. Recommended next phase

- **Phase 2 (local storage)**: config validation, schema migration, atomic writes, credential separation — the highest-risk current debt, and it will let `schemaVersion` move onto stored artifacts safely.
- Then: `applicableKinds`-driven rule configuration (enable/disable rules per assessment), and additional analyzers (config/dependency) on the now-stable extension points.

---

## IMPLEMENTED / PRESERVED / CHANGED / FUTURE

**IMPLEMENTED (in code):**
- Layered structure (`cli`, `core/scanner`, `core/profiles`, `analyzers/source/regex`, `collectors`, `evidence`, `transport`, `storage`, `shared`).
- `Analyzer` interface, `RegexAnalyzer`, `AnalyzerRegistry`, `ScannerEngine`, `ScanContext` (frozen), `EvidenceBundle` with `schemaVersion: 1`, normalize + deduplicate stages.
- Default profile composition root; CLI commands split out with `register*Command(program)` + exported action functions.
- `node:test` test suite (33 tests) and `npm test`.

**PRESERVED (deliberately retained):**
- All 9 CLI commands, options, help text, output and error messages.
- Backend endpoints, `Bearer` auth, `DPDP_USER_TOKEN` report flow, submit payload shape.
- `~/.dpdp/config.json` field names and semantics; old files remain readable.
- `Finding` fields, `findingType` values, `controlCandidates`, `confidence`, `sourceHash` computation (sha256 of decoded content).
- `relative/path:line` location format; `location|findingType` dedup semantics; ignore-dirs list; 1.5 MB size cap; silent oversized-skip; local-first persistence (findings saved before the scan-job API call).
- Scanner output ordering within files; read-only scanning; no symlink following; per-directory discovery tolerance.
- Zero new runtime/Dev dependencies (Commander only).

**CHANGED (intentional, documented):**
- Pattern applicability is now explicit `applicableKinds` (clean per-kind) — removes 4 cross-kind findings on the fixture (18 → 14), zero differences on retained findings.
- Non-fatal scan issues now surface as `scan warning:` lines on stderr (previously silent).
- `rescan` calls scan/submit actions directly (no observable difference).
- `.gitignore` gained `dist/` (the `,gitignore` → `.gitignore` fix was already committed in the repo prior to this phase).

**FUTURE (architecture prepared, not implemented):**
- AST, config, dependency, runtime, security/VAPT, AI analyzers; non-file collectors (process/network/environment); `Collector → Evidence` flows; config validation/migration/atomic writes; on-wire schema versioning; plugin-style rule configuration.
