# Phase 2 Handoff Report — Local State & Storage

**Objective:** Production-grade local storage for the DPDPOS CLI: configuration, credentials, scan state and evidence artifacts separated, with automatic non-destructive migration for existing users — while the Phase 1 scanner architecture, CLI commands and backend contracts stay untouched.

---

## 1. Summary of changes

- Replaced the single `~/.dpdp/config.json` (config + token + state + evidence mixed) with four separated storage areas under `~/.dpdp/`.
- Introduced **centralized storage schema versioning** (`schema.json` + a migration registry) with **automatic legacy migration** (v1 → v2), idempotent and non-destructive.
- Introduced four small store abstractions — `ConfigStore`, `CredentialStore`, `ScanStateStore`, `EvidenceStore` — composed via `openStorage()`; the rest of the app never touches physical files.
- Added **atomic writes** (temp file + rename) everywhere.
- Credentials get **mode 0600** on POSIX; the token never shares a file with config/state/evidence and never appears in output/errors.
- Per-scan **state** (`state/scans/<scanId>.json`, current-scan pointer) and per-scan **evidence artifacts** (`evidence/<scanId>.json`) — multiple scans never overwrite each other; evidence survives failed submissions and is retrievable offline.
- Commands (`init`, `login`, `configure`, `scan`, `evidence`, `submit`, `status`, `report`) rewritten against the stores; `transport/api.ts` now takes explicit `apiBaseUrl` + `token`. `rescan` unchanged. Backend endpoints/payload/auth untouched.
- Tests expanded from 33 → 63 (three new suites: migration, stores, CLI flow).

## 2. Final folder structure (storage additions)

```
src/
├── cli/commands/
│   ├── context.ts              # NEW requireConfig()/requireToken() helpers (clear, consistent errors)
│   └── init|login|configure|scan|evidence|submit|status|report|rescan.ts  (rewritten, except rescan)
├── storage/                    # NEW (Phase 2)
│   ├── index.ts                # openStorage(), Storage composition, defaultStorageRoot() (lazy)
│   ├── schema.ts               # STORAGE_SCHEMA_VERSION, ensureStorage(), v1→v2 migration
│   ├── fs-utils.ts             # storagePaths(), assertSafeId(), atomicWriteJson(), readJsonFile()
│   ├── config-store.ts         # ConfigStore
│   ├── credential-store.ts     # CredentialStore (mode 0600)
│   ├── scan-state-store.ts     # ScanStateStore
│   └── evidence-store.ts       # EvidenceStore
├── transport/api.ts            # signature change only (apiBaseUrl, token explicit)
└── shared/errors.ts            # + StorageError taxonomy (storage.read/write/corrupt/migration/schema/path_unsafe)
```

Phase 1 scanner (`core/scanner`, `analyzers`, `collectors`, `evidence/types|normalize|deduplicate`) — **untouched**.

## 3. Old storage → new storage mapping

| Legacy `~/.dpdp/config.json` field | New location |
|---|---|
| `apiBaseUrl` | `config/config.json` → `ConfigStore` |
| `assessmentId` | `config/config.json` → `ConfigStore` |
| `token` | `credentials/credentials.json` (mode 0600) → `CredentialStore` |
| `lastScanJobId` | `state/scans/<scanId>.json` `scanJobId` (+ current-scan pointer) |
| `lastFindings` | `evidence/<scanId>.json` → `EvidenceStore` |

The legacy file itself is left **untouched** (non-destructive).

## 4. Storage architecture

```
~/.dpdp/
  schema.json                    { schemaVersion: 2 }  ← commit marker, written last
  config/config.json             { apiBaseUrl, assessmentId }
  credentials/credentials.json   { token }              ← mode 0600 on POSIX
  state/current-scan.json        { scanId }
  state/scans/<scanId>.json      per-scan state
  evidence/<scanId>.json         { scanId, schemaVersion, findings }
```

- `openStorage(root = defaultStorageRoot())` runs `ensureStorage` (detect → migrate → init) and returns `{ config, credentials, scans, evidence }`.
- The four stores are small, single-responsibility interfaces — deliberately **not** a giant StorageManager. Physical layout is an implementation detail in `storage/fs-utils.ts`.
- `defaultStorageRoot()` is computed lazily (a module-load-time constant would break `HOME` overrides — a bug caught by the CLI-flow tests).

## 5. Config schema (`config/config.json`)

```jsonc
{ "apiBaseUrl": "http://127.0.0.1:3000", "assessmentId": "…" }
```

Stable configuration only — no scan results, no evidence, no token. `ConfigStore.load()` returns `null` when the CLI was never configured; malformed files throw a tagged `storage.corrupt` error naming the file.

## 6. Credential schema (`credentials/credentials.json`)

```jsonc
{ "token": "dpdp_…" }
```

- Written with `mode: 0o600` (POSIX; no-op on Windows — documented).
- The token is passed explicitly to `transport/api` and never rendered in command output, error messages, or non-credential files (asserted by tests).
- No encryption: credentials are a bearer token for a CLI-local file with restrictive permissions (the task's requirement is separation + permissions, not at-rest encryption).

## 7. Scan/assessment state schema (`state/scans/<scanId>.json`)

```jsonc
{
  "scanId": "scan-<uuid>",
  "assessmentId": "…",
  "scanJobId": "job-…",          // set after the backend job is created
  "targetType": "MIXED",
  "targetPath": "/abs/path",
  "status": "scanned | job_created | submitted | failed",
  "timestamps": { "scannedAt": "ISO", "submittedAt": "ISO" },
  "submission": { "state": "pending | submitted | failed", "submittedAt": "ISO", "error": "…" },
  "evidenceFile": "evidence/<scanId>.json"
}
```

- `state/current-scan.json` holds `{ scanId }` — the "current/last scan" pointer used by `evidence`/`submit`/`status`.
- Extensible by design: future capability types (VAPT, etc.) add their own state shapes instead of one giant object.
- Optional fields are omitted (not `undefined`) so on-disk and in-memory shapes are identical (normalized by `compactScanState`).

## 8. Evidence storage schema (`evidence/<scanId>.json`)

```jsonc
{ "scanId": "scan-<uuid>", "schemaVersion": 1, "findings": [ …Finding… ] }
```

- `findings` are the exact Phase 1 `Finding` records (backend contract unchanged).
- Keyed by scan id → multiple scans coexist; evidence is loaded on demand (never eagerly into memory) and retrievable offline without config/credentials.

## 9. Schema versioning

- `STORAGE_SCHEMA_VERSION = 2`, stored in `schema.json`.
- **Centralized** in `storage/schema.ts`: `ensureStorage()` identifies the current version, detects legacy (v1) storage, migrates forward, and **rejects unsupported future versions** with: `Unsupported storage schema version 999 (this CLI supports up to 2). Upgrade the dpdp CLI to use this storage.`
- No migration logic lives in commands.

## 10. Migration mechanism (v1 → v2)

`ensureStorage()`:
1. No `schema.json` + legacy `config.json` present → **v1** → run `migrateV1ToV2`.
2. No `schema.json` + no legacy config → **fresh** → create dirs + write schema v2.
3. `schema.json` older than current → migrate forward.
4. `schema.json` newer than current → reject.

`migrateV1ToV2` writes (in order): `config/config.json`, `credentials/credentials.json` (0600), scan state + evidence + current-scan pointer (if `lastScanJobId`/`lastFindings` exist), and **`schema.json` LAST as the commit marker** — a crash mid-migration leaves the storage at v1, so the next run re-migrates. The migrated scan id is **derived deterministically** (`scan-<sha256 of legacy job+findings>.slice(0,16)`), making re-runs idempotent.

## 11. Legacy migration example

Given an existing `~/.dpdp/config.json` with all five fields, the first `dpdp` command (e.g. `dpdp evidence`) produces:

```
~/.dpdp/
  schema.json                    { schemaVersion: 2 }
  config/config.json             { apiBaseUrl, assessmentId }        ← preserved
  credentials/credentials.json   { token }  (0600)                   ← preserved
  state/current-scan.json        { scanId: "scan-c1ee…" }
  state/scans/scan-c1ee….json    { scanJobId: "legacy-job-42", … }
  evidence/scan-c1ee….json       { findings: [ …legacy lastFindings… ] }
~/.dpdp/config.json              ← left untouched
```

`dpdp evidence` immediately prints the migrated findings (`Total: 1`); `dpdp submit` can still retry with the preserved job id — no rescan needed. Verified manually (see §19).

## 12. Atomic write mechanism

`atomicWriteJson()`: write `JSON` to `<target>.<pid>.<random>.tmp` in the same directory, then `fs.rename()` over the target. `rename` is atomic on POSIX and replaces existing files on Windows (MoveFileEx). Readers never observe torn content; a crash leaves only a harmless `.tmp` file. Every store write uses it.

## 13. File permission behavior

- `credentials/credentials.json` written with mode `0o600` (owner rw) — including the temporary file, so credentials are never world-readable mid-write. Windows ignores the mode (no Unix-style permissions); behavior documented.
- Other storage files use default modes (umask). `dpdp init`/`openStorage` create the directory tree with default modes.
- Not enforced at read time (no `chmod` repair pass) — documented as acceptable for a CLI-local store.

## 14. Concurrency behavior

- **Per-file atomicity:** every write is an atomic rename; no torn/corrupt JSON (tested with 10 concurrent writes).
- **Cross-file transactions are not atomic:** e.g. `scan` = create state → save evidence → set current pointer → create job → update state. Concurrent scans write distinct scan-id files, so they never corrupt each other; the shared `current-scan.json` pointer and `config.json` are last-writer-wins. No locking is implemented — the task explicitly allows documenting this limitation for a simple filesystem store.
- Migrations: `schema.json` commit marker last; concurrent migrations from v1 are idempotent (deterministic scan id, same files).

## 15. Path safety

- All scan/job/assessment identifiers used in artifact paths pass through `assertSafeId()`: must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` or the operation fails with `storage.path_unsafe` — rejecting `../`, absolute paths, spaces, dots, backslashes, overlong ids.
- Applied in `storagePaths().scanState/evidence` (so every store method inherits it), `setCurrentScanId`, and `EvidenceStore.save`.
- `assessmentId` is stored as data only (never used to build paths).

## 16. CLI command impact

| Command | Behavior |
|---|---|
| `init` | Same output; now initializes the full storage tree + schema marker. |
| `login` | Same behavior (creates/merges config); token → credentials store; prints config path (`~/.dpdp/config/config.json`). |
| `configure` | Same; requires config to exist → clear error `No CLI configuration found. Run dpdp login …` (replaces cryptic ENOENT). |
| `scan` | Same output/order: scan → **evidence + state saved locally first** → job created → `scanJobId` persisted. |
| `evidence` | Prints the current scan's evidence; on a fresh install prints `[]` + `Total: 0` instead of an ENOENT crash (intentional). |
| `submit` | Same message for missing data; records `submission.state` (submitted/failed); on failure evidence is preserved for retry. |
| `status` | Same; uses current scan's job id. |
| `report` | Same; requires config. |
| `rescan` | Unchanged (calls scan + submit actions). |

Command names, arguments, flags, help text, stdout messages and backend endpoints are unchanged.

## 17. Backend compatibility

- Endpoints: `POST /api/v1/assessments/:id/cli/scans`, `POST …/cli/evidence/batch`, `GET …/cli/scans/:jobId`, `GET …/report` — unchanged strings.
- `submit` payload `{ scanJobId, findings }` — byte-identical shape (findings carry no new fields).
- Auth `Authorization: Bearer <token>` and `DPDP_USER_TOKEN` flow — unchanged.
- The backend has no knowledge of the storage refactor (verified with a mock backend: scan → job, batch accepted 14, status COMPLETED).

## 18. Tests added (33 → 63)

| Area | Where |
|---|---|
| 1. Legacy config loading | `storage/migration.test.ts` |
| 2. Migration from legacy config (all 5 fields) | same |
| 3. Migration idempotency (incl. re-run after partial failure) | same |
| 4. Invalid configuration | same |
| 5. Unsupported schema version | same |
| 6. Atomic writes (no tmp leftovers; concurrent writes) | `storage/stores.test.ts` |
| 7. Credential separation (token absent from config/state/evidence) | same |
| 8. Credential file permissions (0600, POSIX; skipped on win32) | same |
| 9. Configuration persistence | same |
| 10. Scan state persistence | same |
| 11. Evidence persistence | same |
| 12. Multiple scan artifacts | same + `cli-flow.test.ts` |
| 13. Offline evidence retrieval | stores |
| 14. Failed submission preserving evidence (retry without rescan) | `cli-flow.test.ts` |
| 15. Corrupted state | migration tests |
| 16. Missing storage directories (fresh root) | migration tests |
| 17. Path traversal protection | stores |
| 18. Existing CLI command behavior (workflow + error messages) | `cli-flow.test.ts` |

## 19. Build / test / manual verification results

- `rm -rf node_modules dist && npm install` → clean, 0 vulnerabilities.
- `npm run build` → passes. `npm test` → **63/63 pass**; test files typecheck standalone.
- Manual (temp `HOME`, compiled `dist/index.js`):
  - Full flow with a mock backend: `init → login → configure → scan` (14 findings, job `mock-job-1`) → `submit` (backend 500 once) → `evidence` still `Total: 14` → `submit` retry `accepted: 14` → `status COMPLETED` → submission state recorded.
  - Legacy migration: v1 `config.json` → all five fields preserved, credentials `0600`, legacy file untouched, `evidence` works immediately.
  - Edge cases: schema v999 → clear "unsupported" error; corrupt `current-scan.json` → clear fix-or-remove error; `assertSafeId("../evil")` → rejected.

## 20. Security considerations (reviewed)

- Token exposure: token only ever in `credentials/credentials.json` (0600); never in evidence/state/config output or our error strings; not echoed by the CLI (tests assert absence in all non-credential files).
- Temporary files: credential temp files carry the restrictive mode; write failures clean up the temp file.
- Path traversal: safe-id gate on every artifact path (see §15).
- Corrupted/partial state: clear tagged errors; `schema.json` commit marker prevents half-migrated storage being treated as migrated.
- Note: `submit` stores the backend error message in `submission.error` (state file only, never printed by the CLI); it can contain backend-provided text, but never our token.

## 21. Future capability extensibility

- New capability (e.g. dependency analysis, runtime checks, VAPT) needs: a scan state shape of its own (new file under `state/scans/` or a future `state/<capability>/` area — the store interface stays), evidence stored via `EvidenceStore` keyed by its own safe id, and registration in its profile. `openStorage`/stores do not change.
- The four-store composition and per-scan artifact layout already support: assessment metadata (`assessmentId`), target info (`targetType`/`targetPath`), execution state (`status`/`timestamps`), findings/evidence (artifacts), submission/verification state (`submission`).
- `FileCollector`/`Analyzer`/`AnalyzerRegistry` from Phase 1 remain the execution extension points; storage is orthogonal.

## 22. How VAPT can later fit

```
VAPT capability (bounded, new module, not implemented now)
  ├─ authorized scope / targets        → config or per-assessment config
  ├─ scan profile                      → profile registers VAPT analyzers/collectors
  ├─ execution state                   → its own scan-state entries (state/scans/<id>.json)
  ├─ security findings                 → EvidenceStore artifacts (new finding shape, own schemaVersion)
  ├─ evidence/artifacts                → evidence/<scanId>.json (+ future artifact dirs)
  └─ backend                           → same transport/api()
```

No VAPT code was written; the storage/core boundaries (assessments → scoped execution → findings/artifacts → evidence → backend) are already representable. Nothing forces VAPT into the DPDP file-scanner pipeline.

## 23. Remaining technical debt

- **Concurrency:** no locking; cross-file sequences (scan → pointer → job) are last-writer-wins for shared pointers. Documented, acceptable per the task.
- **Config validation:** light hand-rolled checks (string fields) — no schema library; future migrations may want stricter validation.
- **Windows permissions:** 0600 is a no-op; Windows ACLs not managed (documented).
- **Stale `.tmp` files** after a hard crash are not garbage-collected (harmless; documented).
- **`submission.error`** stores backend error text; no redaction pass (our own messages never include the token).
- **No cross-scan history listing** beyond `scans.list()`; a future "list scans/assessments" UX can build on it.
- **Evidence format version** stays the Phase 1 bundle `schemaVersion: 1`; per-capability evidence versioning is future work.

## 24. Recommended next phase

- **Phase 3 (assessment model + backend state sync):** formal `Assessment` records (multiple assessments per CLI, per-assessment profiles/targets), and richer scan history/status reporting (`dpdp scans`, `dpdp scans <id>`) on top of `ScanStateStore.list()`.
- Then: configurable rule sets per assessment, and the first second analyzer (dependency/config) to exercise the full collector→analyzer→evidence→storage path end to end.

---

## IMPLEMENTED / PRESERVED / CHANGED / MIGRATION / FUTURE

**IMPLEMENTED (in code):**
- Storage layer: `storage/{index,schema,fs-utils,config-store,credential-store,scan-state-store,evidence-store}.ts` with `openStorage()`, schema v2 marker, v1→v2 migration, atomic writes, safe-id path gating, 0600 credentials.
- Four store abstractions used by all commands; `cli/commands/context.ts` helpers.
- Submission state tracking (`submission.state` on scan state) and per-scan evidence artifacts.
- 63 tests (30 new), README storage docs.

**PRESERVED:**
- Phase 1 scanner architecture (`ScannerEngine`, `AnalyzerRegistry`, `RegexAnalyzer`, `ScanContext`, collectors, evidence normalize/dedup, applicability) — not modified.
- All 9 CLI commands, names, flags, help, stdout output and backend endpoints/payloads/auth.
- `~/.dpdp/config.json` legacy data (migrated, never deleted); legacy file untouched.
- Phase 1 33 tests still pass unchanged.
- Zero new runtime dependencies (still Commander only); test runner still `node:test` via `tsx`.

**CHANGED (intentional, documented):**
- Storage layout (config/credentials/state/evidence separation) with automatic migration.
- Clear actionable error messages replace raw `ENOENT` for missing config (`No CLI configuration found. Run dpdp login …`).
- `evidence` on a never-configured install prints `[]` + `Total: 0` instead of failing.
- `login` prints the new config path (`~/.dpdp/config/config.json`).
- `transport/api` signature (explicit `apiBaseUrl`, `token`).
- `setCurrentScanId`/artifact paths validate identifiers (was implicit).

**MIGRATION (users):**
- Existing `~/.dpdp/config.json` is detected on first command, migrated non-destructively and idempotently (deterministic scan id, `schema.json` commit marker written last); `submit` retry with the preserved job id keeps working without rescanning.

**FUTURE (prepared, not implemented):**
- Multiple assessments, per-assessment profiles/targets, scan history UX, stricter config validation, VAPT and other capabilities (their state/evidence/execution shapes are representable without another storage redesign).
