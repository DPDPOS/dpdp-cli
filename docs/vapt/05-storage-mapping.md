# VAPT Storage Mapping

> Design document — nothing here is implemented. The Phase 2 storage
> architecture is the source of truth and is **not redesigned**; this
> document maps VAPT concepts onto it and identifies the genuine gaps.

## 1. Phase 2 layout (as built)

```
~/.dpdp/
  schema.json                    { schemaVersion: 2 }
  config/config.json             { apiBaseUrl, assessmentId }        ← ConfigStore
  credentials/credentials.json   { token }  (0600)                   ← CredentialStore
  state/current-scan.json        { scanId }                          ← ScanStateStore
  state/scans/<scanId>.json      per-scan state                      ← ScanStateStore
  evidence/<scanId>.json         { scanId, schemaVersion, findings } ← EvidenceStore
```

## 2. VAPT concept → Phase 2 location

| VAPT concept | Phase 2 home | Fit / change |
|---|---|---|
| CLI config (`apiBaseUrl`) | `ConfigStore` | ✅ reuse unchanged |
| dpdp credential (`token`) | `CredentialStore` | ✅ reuse unchanged |
| Assessment record + scope + profile config | **new** per-assessment config | ⚠️ gap 1 (below) |
| Target auth credentials (if any) | `CredentialStore` (namespaced) or env-only | ⚠️ gap 2 (below) |
| Scan execution state | `ScanStateStore` (`state/scans/<id>.json`) | ⚠️ gap 3: needs capability tag |
| Findings + evidence items | `EvidenceStore` (`evidence/<scanId>.json`) | ⚠️ gap 4: needs VAPT schema version + capability field |
| Raw artifacts (large/binary) | — | ⚠️ gap 5: new artifact store |
| Current-scan pointer | `state/current-scan.json` | ✅ reuse (per-capability pointer optional) |
| Backend job id, submission state | `ScanStateStore.submission` | ✅ reuse unchanged |

Everything that already exists is reused: atomic writes
(`fs-utils.atomicWriteJson`), path-safe ids (`assertSafeId`), schema
versioning + migration (`schema.ts`), restrictive credential permissions,
and the local-first "evidence survives failed submission" flow.

## 3. Genuine gaps (and the minimal way to close them)

### Gap 1 — Per-assessment VAPT configuration (scope/profile)

`ConfigStore` holds exactly one global `assessmentId`; it must not grow into a
catch-all. Proposed (minimal):

```
config/vapt/<assessmentId>.json     { scope, profile, scopeVersion, updatedAt }
```

- New small store `VaptConfigStore` following the `ConfigStore` pattern
  (same `atomicWriteJson`/`readJsonFile` helpers).
- `assessmentId` must pass `assertSafeId` before use in the path (already the
  storage-wide rule).
- Not a storage redesign: a new file + a small store interface, no changes to
  `openStorage`'s existing stores.

### Gap 2 — Target authentication secrets

VAPT may need target credentials (basic auth, session, header) to assess
authenticated surfaces. Options (see open decisions):

- **Recommended:** reference-only config — `VaptAuthRef.credentialId` points
  at a namespaced credential record stored with the same 0600 + atomic-write
  guarantees as `credentials.json`, OR
- **Env-only:** secrets supplied at run time via environment variables, never
  persisted by the CLI.

Either way: target credentials are **never** in scope/config files, never in
findings/evidence, never in backend payloads, and never printed.

### Gap 3 — Capability-tagged scan state

Phase 2 `ScanState` has no capability dimension. Minimal change (backward
compatible — optional field, migration not required):

```
state/scans/<scanId>.json  gains optional  "capability": "VAPT"
```

- Existing DPDP scans simply omit it (v2 schema unchanged; optional field,
  no schema bump required — or a v3 migration if strictness is wanted; see
  open decisions).
- `ScanStateStore` interface unchanged; a VAPT scan additionally carries
  `VaptScanState` fields (config snapshot, checks executed/skipped, status
  `queued|running|completed|failed|cancelled`).

### Gap 4 — VAPT evidence schema version

`EvidenceStore` artifacts use `EVIDENCE_SCHEMA_VERSION = 1` (DPDP `Finding`).
VAPT findings are a different family. Minimal change:

```
evidence/<scanId>.json  envelope gains  "capability": "VAPT", "schemaVersion": 2
```

- Findings array holds `VaptFinding` records; the DPDP payload and DPDP
  evidence files are untouched (versioning is per-artifact, as designed in
  Phase 1/2).
- `EvidenceStore.save/load` accept the capability-tagged envelope; the store
  interface stays the same shape.

### Gap 5 — Raw artifact storage

Phase 2 stores exactly one JSON artifact per scan. VAPT needs large/binary
artifacts stored separately:

```
evidence/artifacts/<scanId>/<artifactId>      (artifact bytes)
evidence/artifacts/<scanId>/<artifactId>.json (metadata: kind, mime, size, sha256)
```

- New small `ArtifactStore` abstraction (`save/list/load`), mirroring
  `EvidenceStore`: safe ids, atomic writes, sha256 integrity, **no eager
  loading** (metadata-only listing), size caps + retention limits as config.
- Findings reference artifacts by `artifactId` + sha256 only; artifacts are
  submitted to the backend as a separate channel.

## 4. Guarantees carried over unchanged

- **Path safety:** every identifier used in a path (assessmentId, scanId,
  artifactId) passes `assertSafeId` — no traversal, no absolute-path
  injection, no escape from `~/.dpdp/`.
- **Atomicity:** all new writes go through `atomicWriteJson` (temp + rename).
- **Permissions:** any new credential-adjacent file is written with restrictive
  mode (0600 on POSIX; documented no-op on Windows).
- **Migration:** adding VAPT files does not change `schema.json` semantics;
  future schema bumps continue through `schema.ts` migrations, never through
  commands.
