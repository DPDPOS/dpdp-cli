# VAPT CLI Command Proposal

> Design document — no commands are implemented. The proposal follows the
> existing CLI conventions (`src/cli/commands/*.ts` + `src/cli/program.ts`):
> each command is thin, uses storage/transport abstractions, and never
> contains engine logic.

## Command tree

```
dpdp vapt                       # capability group; prints help
├── scope                       # define/show the authorized scope
├── scan                        # run one scan against the scope
├── findings                    # preview local findings
├── submit                      # submit findings (+ artifact refs) to the backend
├── status                      # scan execution + submission status
└── cancel                      # request cooperative cancellation of a running scan
```

Six subcommands. No more until there is a demonstrated need (e.g. `dpdp vapt
list` for scan history can build on `ScanStateStore.list()` later).

## 1. `dpdp vapt scope`

- **Purpose:** create or update the authorization contract for an assessment.
  A scan refuses to run without one.
- **Required inputs:** assessment id (or creates one), target + target type,
  exclusions, profile, mode, authorization metadata (authorizedBy, purpose,
  optional expiry), optional allowed ports/services.
- **Generated state:** per-assessment scope + config record (see storage
  mapping); `scopeVersion` bumped on every edit.
- **Produced output:** scope summary with `scopeVersion`, target, exclusions,
  mode, expiry.

## 2. `dpdp vapt scan`

- **Purpose:** execute one VAPT scan of the authorized scope.
- **Required inputs:** existing scope (validated), optional profile/mode
  overrides, timeout/rate overrides. Engine refuses on missing scope,
  uncovered target, or excluded target.
- **Generated state:** new `VaptScanState` (`scan-<uuid>`, status
  `queued → running → completed/failed/cancelled`), per-scan evidence
  artifact, findings.
- **Produced output:** scan summary — scan id, checks executed/skipped,
  finding counts per severity, duration.

## 3. `dpdp vapt findings`

- **Purpose:** preview findings locally, offline (mirrors `dpdp evidence`).
- **Required inputs:** optional `--scan <id>` (defaults to current scan).
- **Generated state:** none (read-only).
- **Produced output:** findings JSON (normalized severities, targets,
  provenance) + counts.

## 4. `dpdp vapt submit`

- **Purpose:** submit the scan's findings + artifact references to the
  backend (mirrors `dpdp submit`; local-first semantics preserved — a failed
  submission keeps evidence and can be retried without rescanning).
- **Required inputs:** optional `--scan <id>`; config + credentials from the
  existing stores.
- **Generated state:** `submission: { state: submitted|failed, submittedAt,
  error }` on the scan state; backend job id recorded.
- **Produced output:** submission result.

## 5. `dpdp vapt status`

- **Purpose:** show execution + submission status (mirrors `dpdp status`).
- **Required inputs:** optional `--scan <id>`; config + credentials.
- **Generated state:** none (read-only).
- **Produced output:** status JSON.

## 6. `dpdp vapt cancel`

- **Purpose:** request cooperative cancellation of a running scan.
- **Required inputs:** `--scan <id>` (defaults to current).
- **Generated state:** `cancellation: { requestedAt, reason }`; engine checks
  the signal between checks.
- **Produced output:** cancellation acknowledgement.

## Design notes

- All six commands follow the existing pattern: `registerXCommand(program)`
  in `src/cli/commands/vapt/*.ts`, actions calling application services
  (`VaptEngine`, stores, `api()`).
- The VAPT engine is invoked from the CLI layer only; the engine itself has
  no Commander dependency (same invariant as `ScannerEngine`).
- Backend calls reuse `src/transport/api.ts` unchanged (same auth, same
  endpoint style) — no new auth mechanism.
- No output prints tokens or credentials (Phase 2 invariant).
