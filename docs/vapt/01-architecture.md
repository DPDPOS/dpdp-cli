# VAPT Architecture & Design

> Design document — nothing here is implemented.

## 1. Context: what the CLI already is

The CLI is an **evidence-collection platform**, not a scanner monolith. Phase 1
and Phase 2 established:

- **`src/core/scanner/`** — `ScannerEngine` orchestrates
  `collect → ScanContext → registered analyzers → normalize → deduplicate →
  EvidenceBundle`. The engine contains **no feature-specific detection rules**;
  it executes whatever analyzers are registered.
- **`src/analyzers/analyzer.ts`** — small composable `Analyzer` interface
  (`id`, `name`, `supportedKinds`, `analyze(context)`), with the existing regex
  scanner as `RegexAnalyzer` under `src/analyzers/source/regex/`.
- **`src/collectors/`** — `FileCollector` interface + `FilesystemCollector`
  (file discovery, ignore dirs, classification).
- **`src/evidence/`** — `Finding` / `RawFinding` / `EvidenceBundle`
  (`schemaVersion: 1`), normalization, deduplication (`location|findingType`).
- **`src/core/profiles/default.ts`** — composition root
  (`createDefaultScanner()`): registry + RegexAnalyzer + FilesystemCollector.
- **`src/storage/`** — `openStorage()` → `{ config, credentials, scans,
  evidence }`; schema versioning (v2), v1→v2 migration, atomic writes,
  path-safe identifiers, per-scan evidence artifacts.
- **`src/transport/api.ts`** — `api(apiBaseUrl, token, method, apiPath, body)`;
  explicit base URL + token; no knowledge of storage or scanning.
- **`src/cli/`** — 9 Commander commands; the scanner engine does not depend on
  Commander.

## 2. VAPT as a bounded capability

VAPT is a **first-class capability** of the CLI with its own execution model.
The core design constraint:

> A VAPT check targets hosts, URLs, IPs and services — **not files**. Forcing
> VAPT into the Phase 1 `Analyzer` abstraction (which consumes a per-file,
> content-string `ScanContext`) would distort both abstractions.

Therefore VAPT is **not** a Phase 1 `Analyzer`. It gets its own small engine
that mirrors the proven pipeline shape (collectors → checks → normalize →
evidence → storage → backend) while reusing the shared infrastructure:

| Shared infrastructure | How VAPT reuses it |
|---|---|
| `src/evidence/` types & pattern | New `VaptFinding` family with its **own schema version** (see §7 of the data contract) |
| `src/storage/` stores | Same `openStorage()` stores; capability-tagged scan state + per-scan evidence artifacts |
| `src/transport/api.ts` | Same HTTP client, same auth, same endpoint style |
| `src/shared/errors.ts` | Same tagged error taxonomy (new `vapt.*` codes) |
| `src/core/profiles/` composition pattern | A `createVaptProfile()` / engine wiring analogous to `createDefaultScanner()` |

### Where it lives

Proposed module boundary (new top-level area, not inside `core/scanner`):

```
src/vapt/
├── engine/          VaptEngine — orchestrates one scan (scope gate → checks → evidence)
├── scope/           scope model, validation, authorization checks
├── checks/          check definitions + registry (declarative data, not engine code)
├── collectors/      target collectors (http, tls, config, service metadata)
├── findings/        VaptFinding types + severity normalization
└── profile/         profile selection (which checks run, mode, limits)
```

This mirrors the layered structure the CLI already uses. A future
**file-based** security analyzer (e.g. secrets scanning, dependency checks)
would still be a regular Phase 1 `Analyzer` — the two extension models coexist:

- **File-based capability** → `Collector → Analyzer → Evidence` (existing).
- **Runtime/service capability (VAPT)** → `VaptEngine → checks/collectors →
  findings → Evidence` (new, bounded).

## 3. Execution flow

```
dpdp vapt scan
  └─ VaptEngine.run(assessment, profile)
       ├─ LOAD scope (required) + profile (check set + mode + limits)
       ├─ SCOPE GATE: refuse if scope missing, target not covered, or
       │              excluded target requested        [fail closed]
       ├─ create scan state (status: running)
       ├─ for each check in profile (respecting concurrency/rate limits):
       │     check.supportedTargetTypes ∩ scope.targets
       │     → collectors gather observations (http, tls, ...)
       │     → check logic produces observations / raw findings
       │     cooperative cancellation checked between checks
       ├─ normalize: raw observations → VaptFinding (severity mapping, sanitization)
       ├─ attach evidence items + raw artifact references
       ├─ deduplicate (VAPT key — see §7)
       ├─ persist: scan state + evidence artifact (local-first)
       └─ report summary (checks run/skipped, finding counts)
```

`VaptEngine` follows the same invariants as `ScannerEngine`:

- **No feature-specific rules in the engine** — checks are data registered
  into a check registry; adding a check never touches the engine.
- **Read-only / non-destructive by default** — safe mode is the default; any
  active/destructive behavior is gated by explicit configuration.
- **Never touches storage or Commander directly** — it uses the store
  abstractions; backend submission is a separate step (`submit`).
- **One failing check does not abort the scan** — errors are collected
  per-check (mirroring `ScanIssue[]`).

## 4. The four domain concepts (summary)

Defined in full in [`02-data-contract.md`](./02-data-contract.md); the
distinction is the foundation of the whole contract:

| Concept | Meaning | Example identity |
|---|---|---|
| **Assessment** | The overall authorized VAPT engagement for one target (or target set) under an explicit scope | `assessment-<uuid>` (type `VAPT`) |
| **Scan** | One execution/run of the assessment with a specific profile + config snapshot | `scan-<uuid>` |
| **Finding** | A security issue discovered during a scan | `finding-<uuid>` + `checkId` |
| **Evidence** | The technical observation supporting a finding (structured, small) | `ev-<uuid>` |
| **Raw artifact** | Large/raw scanner output supporting evidence (stored separately) | `art-<uuid>` + sha256 |

They are deliberately **not collapsed** into one object: an assessment has
many scans; a scan has many findings; a finding references several evidence
items and artifacts.

## 5. Relationship to DPDP compliance

VAPT produces **security findings + technical evidence**. It does **not**
directly produce:

- DPDP PASS/FAIL
- a compliance score
- control evaluation

Later, the backend may map relevant security findings to DPDP controls (e.g. a
HIGH TLS-configuration finding may contribute evidence for a DPDP control).
That mapping is **backend-side evaluation**, out of the CLI's contract. The
CLI ships findings + evidence with rich classification (category, severity,
target, provenance) precisely so the backend can do that mapping later.

VAPT severity (INFO…CRITICAL) and DPDP compliance score are **separate
concepts**; severity is normalized per §6 of
[`03-finding-evidence-model.md`](./03-finding-evidence-model.md) and is not a
compliance score.

## 6. Safety & authorization model

Requirements for the capability (design only):

- **Explicit target scope is a required input** — there is no default, and a
  scan refuses to start without a validated scope (fail closed).
- **Inclusions and exclusions** — scope lists included targets and excluded
  targets; exclusions take precedence and are enforced at the **engine level**
  (not per-check), so a check can never contact an excluded target.
- **Allowed ports/services** — scope may restrict which ports/services may be
  contacted; the engine refuses anything outside them.
- **Safe scanning mode is the default** — `mode: passive | active-safe |
  active`; anything beyond passive/active-safe requires explicit
  configuration plus scope authorization. No exploitation functionality is
  designed here.
- **Rate/concurrency limits** — per-second request rate and max parallel
  checks are scan-config values with conservative defaults.
- **Cancellation** — a cooperative cancellation signal checked between checks;
  the scan state records `cancelled` with `cancelledAt`/reason.
- **Auditability** — every scan records provenance: scanner/engine versions,
  check catalog version, profile + scope snapshot, timestamps, and
  check-level executed/skipped lists. Scope changes are versioned.

## 7. Open design decisions

See [`08-open-decisions.md`](./08-open-decisions.md). The most consequential
for architecture: (1) single- vs multi-assessment CLI model, (2) where VAPT
target credentials live, (3) whether `ScanState` gains an optional
`capability` field or VAPT uses parallel state, (4) raw artifact storage
location/limits.
