# Phase 3 Handoff Report — VAPT Design & Data Contract

**Scope of this phase:** design/documentation only. No application code,
backend APIs, scanners, dependencies, or database migrations were created or
modified. The only file changed outside `docs/` is `README.md` (a pointer to
the new design documents).

---

## IMPLEMENTED (documents created)

New directory `docs/vapt/`:

```
docs/vapt/
├── README.md                 index + reading order + relationship to existing docs
├── 01-architecture.md        VAPT module boundary, execution flow, DPDP relationship, safety model
├── 02-data-contract.md       Assessment / Target / Scope / Scan config / Execution state / Check models
├── 03-finding-evidence-model.md   Finding, Evidence, Raw Artifact models; severity normalization; field rationale
├── 04-cli-command-proposal.md    Conceptual `dpdp vapt …` command tree (6 subcommands)
├── 05-storage-mapping.md     VAPT → Phase 2 storage mapping; 5 genuine gaps with minimal closures
├── 06-backend-requirements.md    Conceptual backend operations; what the backend must never receive
├── 07-example-lifecycle.md   End-to-end lifecycle example incl. failure/retry path
└── 08-open-decisions.md      10 decisions required before implementation, each with a recommendation
```

`README.md` gained a "Design documents" pointer section. `HANDOFF_PHASE1.md`
and `HANDOFF_PHASE2.md` are phase snapshots and were deliberately **not**
rewritten; `docs/vapt/README.md` identifies them as source of truth and
explains what this phase adds vs reuses.

## VAPT MODEL (final proposed domain model)

Four concepts, never collapsed:

- **Assessment** — the overall authorized engagement: `assessmentId`,
  `type: "VAPT"`, primary `target`, required `scope` (the authorization
  contract), status, timestamps, scan history. Holds everything stable
  across runs.
- **Scan** — one execution: `scanId`, `assessmentId`, `capability: "VAPT"`,
  config snapshot (reproducibility), `scopeVersion`, status
  (`queued → running → completed | failed | cancelled`), timestamps/duration,
  scanner provenance, `checks.executed/skipped`, error/cancellation state,
  submission state, evidence ref, findings count.
- **Finding** — one security issue: identity (`findingId`, `checkId`),
  classification (`category`, normalized `severity`, `title`, optional
  `findingCode` — deliberately no redundant `type` field), target
  (hostname/ip/url/port/protocol/endpoint), description + impact, evidence
  refs (never inline blobs), remediation (recommendation + priority),
  references (standards/advisories/CWEs/CVEs), provenance (scanner, versions,
  source, timestamps). Every field has a stated reason.
- **Evidence / Raw Artifact** — evidence items are small structured
  observations (observation/http/tls/config/service) with a mandatory
  sanitization policy; raw artifacts are large/binary and stored separately
  with `sha256` integrity, referenced by id only.

**Severity:** normalized 5-point model `INFO | LOW | MEDIUM | HIGH |
CRITICAL`; per-scanner mapping tables (versioned with the check catalog);
unmapped values fail toward LOW with a flag + non-fatal warning. Severity is
**not** a compliance score.

**Check model:** declarative data — `checkId`, name, category, description,
`supportedTargetTypes`, `defaultSeverity`, version, execution requirements —
registered into a check registry so future checks never touch the engine.

## CLI CONTRACT (what the CLI will eventually collect/produce)

Six subcommands under `dpdp vapt`: `scope`, `scan`, `findings`, `submit`,
`status`, `cancel`. Each follows the existing `registerXCommand(program)` +
thin-action pattern. The engine:

- refuses to run without a validated scope (fail closed; exclusions enforced
  engine-level; allowed ports/services enforced),
- defaults to safe/non-destructive mode, applies rate/concurrency limits,
  supports cooperative cancellation,
- records full provenance + scope/profile snapshots per scan (auditability),
- persists findings/evidence locally **before** any backend call (local-first;
  failed submission → evidence retained → retry without rescanning),
- never prints or ships credentials, auth headers, or secret patterns.

## STORAGE (mapping onto Phase 2)

Phase 2 layout is the source of truth and is not redesigned. Reused
unchanged: `ConfigStore`/`CredentialStore`/`ScanStateStore`/`EvidenceStore`,
atomic writes, `assertSafeId` path safety, schema versioning + migration,
0600 credential permissions, current-scan pointer, submission state.

Five genuine gaps identified with minimal closures:

1. **Per-assessment VAPT config** → new `config/vapt/<assessmentId>.json` +
   small `VaptConfigStore` (same helpers).
2. **Target auth credentials** → namespaced credential records (0600,
   atomic) or env-only; never in config/findings/evidence/payloads.
3. **Capability-tagged scan state** → optional `capability: "VAPT"` field on
   the existing store (backward compatible, no migration).
4. **VAPT evidence schema version** → artifact envelope gains
   `capability` + `schemaVersion: 2`; DPDP evidence untouched.
5. **Raw artifact storage** → new `ArtifactStore` at
   `evidence/artifacts/<scanId>/…` (metadata + bytes, sha256, no eager
   loading, size caps).

## BACKEND REQUIREMENTS

Conceptual operations only (no URLs/payloads): register/create a VAPT scan
(returning a job id, mirroring the DPDP flow), submit findings (pre-normalized
severity, evidence/artifact refs, provenance, capability/schema markers),
submit artifacts as a separate channel (metadata + chunks + sha256), and
retrieve scan status. The backend must never receive credentials, auth header
values, or secret-pattern matches. No compliance scoring or DPDP-control
mapping is designed here (backend-side, later phase). Existing DPDP
endpoints/auth/payloads are untouched.

## ARCHITECTURE (where VAPT fits)

VAPT is a **bounded capability** with its own execution model — it is
deliberately **not** a Phase 1 `Analyzer` (a VAPT check targets hosts/URLs,
not files with content strings; forcing it in would distort both). Proposed
module: `src/vapt/` with `engine/`, `scope/`, `checks/`, `collectors/`,
`findings/`, `profile/`, mirroring the pipeline shape
(`collectors → checks → normalize → evidence → storage → backend`) while
reusing `src/evidence/` patterns, `src/storage/`, `src/transport/api.ts`,
`src/shared/errors.ts`, and the `core/profiles/` composition pattern. Future
file-based security analyzers (secrets, dependency) still use the existing
`Analyzer` extension point — the two models coexist.

## OPEN DECISIONS

Ten, each with a recommendation, in `docs/vapt/08-open-decisions.md`. The
consequential ones: multi-assessment model (start single, keyed by existing
`assessmentId`), target credential storage (env-only first, namespaced store
later), capability tag on `ScanState` (yes, optional field), artifact caps
(per-artifact + per-scan), unmapped severity handling (flag + LOW),
passive-only first slice, within-scan dedup, bundled check catalog,
sanitization allowlist policy, backend job-id correlation (mirror DPDP).

## NEXT STEP (recommended smallest implementation slice)

1. **Implement the scope model + scope gate** as a new bounded `src/vapt/`
   module (`scope/` + `VaptConfigStore` at `config/vapt/<assessmentId>.json`)
   with the first passive check (TLS/HTTP-header observation) registered as
   declarative data — proving the check-registry extension point without
   building the full engine.
2. Add the optional `capability` tag to `ScanStateStore` and the
   capability/schema-version envelope to `EvidenceStore` (backward
   compatible, no migration).
3. Wire the smallest CLI surface: `dpdp vapt scope` + `dpdp vapt scan`
   (passive-only) + `dpdp vapt findings`, reusing `openStorage()` and
   `transport/api.ts` — then submit via a stub backend to validate the
   contract before the backend implements VAPT endpoints.

This slice is deliberately small: it establishes the VAPT boundary, the
scope authorization invariant, and the storage extension points, and leaves
backend endpoint design as the next phase once the contract is validated
end-to-end.

---

## Verification

No code changed (except the README pointer), so build/test status is
unchanged from Phase 2: `npm run build` passes, `npm test` 63/63. Design docs
are plain Markdown under `docs/vapt/`; nothing was implemented.
