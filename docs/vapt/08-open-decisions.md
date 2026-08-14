# VAPT Open Design Decisions

> Design document — decisions that must be made **before** implementation.
> Each entry: the question, why it matters, options, and a recommendation.

## 1. Single-assessment vs multi-assessment CLI model

**Question:** Phase 2 `ConfigStore` holds one global `assessmentId`. VAPT
scopes are per-assessment. Should the CLI support multiple assessments
simultaneously?

- **Why it matters:** determines whether VAPT config lives at
  `config/vapt/<assessmentId>.json` (multi) or a single VAPT config file
  (single), and whether `state/current-scan.json` needs a per-capability
  pointer.
- **Options:** (a) keep single current assessment, VAPT config keyed by that
  assessmentId; (b) introduce formal per-assessment records (the Phase 2 §24
  recommendation) now.
- **Recommendation:** (b) is the eventual target, but **not required for the
  first VAPT slice** — start with (a) and key VAPT config by the existing
  `assessmentId`, leaving the door open for (b) without a storage redesign.

## 2. Target authentication credential storage

**Question:** where do VAPT target credentials (basic auth, session, header)
live?

- **Why it matters:** secrets must never appear in config/scope, findings,
  evidence, backend payloads, or output; Phase 2 `CredentialStore` holds the
  dpdp token and should not be polluted.
- **Options:** (a) namespaced credential records in a
  `credentials/vapt/<assessmentId>.json` with the same 0600 + atomic-write
  guarantees; (b) environment-variable-only, never persisted.
- **Recommendation:** (a) with a strict namespacing rule, falling back to (b)
  for CI use. First slice can ship with (b) only to avoid new credential
  surface.

## 3. ScanState: capability tag vs parallel state

**Question:** does VAPT reuse `state/scans/<scanId>.json` with an optional
`capability` field, or use parallel `state/vapt/<scanId>.json` files?

- **Why it matters:** affects whether `ScanStateStore` gains an optional field
  (backward compatible) or a parallel store; also affects `scans.list()` and
  `current-scan` semantics (DPDP vs VAPT pointer).
- **Options:** (a) optional `capability` field on the existing store —
  backward compatible, no migration; (b) parallel store per capability.
- **Recommendation:** (a). One store, optional tag, no schema bump (or a v3
  migration only if strict typing is preferred). Per-capability
  `current-scan` pointers can be added as `state/current-<capability>.json`.

## 4. Raw artifact storage limits

**Question:** what are the default size caps, retention, and cleanup policy
for `evidence/artifacts/<scanId>/…`?

- **Why it matters:** artifacts can grow unboundedly and bloat `~/.dpdp`;
  large artifacts affect submission design (chunking).
- **Options:** per-artifact cap (e.g. 10 MB) + per-scan total cap (e.g. 100
  MB) with explicit `--no-artifacts` scan option; retention tied to scan
  lifecycle (delete on scan deletion, never on submission).
- **Recommendation:** per-artifact + per-scan caps, configurable; artifacts
  survive failed submission exactly like findings; no auto-delete of
  submitted artifacts in the first slice.

## 5. Severity normalization of unmapped values

**Question:** what happens when a check/tool reports a severity outside the
mapping table?

- **Why it matters:** silent upgrades/downgrades corrupt reporting.
- **Options:** (a) flag `severitySource: "unmapped"` + assign LOW (fail toward
  non-inflation); (b) reject the finding with an engine error.
- **Recommendation:** (a) with a normalization warning collected in scan
  issues (mirrors Phase 1 `ScanIssue[]` — non-fatal, never aborts).

## 6. First-slice check scope: passive-only vs active-safe

**Question:** does the first VAPT slice include active checks?

- **Why it matters:** safety posture, scope of the initial engine, and how
  much of the `mode` matrix needs implementing.
- **Options:** (a) passive checks only (TLS observation, header/config
  inspection); (b) include `active-safe` checks (non-destructive requests).
- **Recommendation:** (a) passive-only first, with `mode` plumbing and the
  scope gate in place so active checks can be added as data later.

## 7. VAPT finding deduplication semantics

**Question:** exact dedup key + first-wins/last-wins for
`target-identity | checkId | endpoint`.

- **Why it matters:** repeated scans of the same target should not accumulate
  duplicate findings; but per-scan history must remain intact (Phase 2
  principle: multiple scans never overwrite each other).
- **Options:** dedup within a scan (first-wins) vs across scans for the same
  assessment (supersede previous finding record).
- **Recommendation:** dedup **within a scan** first (same as Phase 1
  semantics, different key); cross-scan supersession is a backend/reporting
  concern and an open decision for a later phase.

## 8. Check catalog delivery

**Question:** are checks shipped as bundled data files in the CLI, or fetched
from the backend?

- **Why it matters:** affects versioning, offline operation, and whether new
  checks require CLI releases.
- **Options:** (a) bundled, versioned with the CLI; (b) backend-delivered
  catalog with local cache.
- **Recommendation:** (a) for the first slice (offline-first, matches
  local-first storage); (b) is compatible later since checks are declarative
  data behind the check registry.

## 9. HTTP metadata sanitization policy details

**Question:** exact rules for what is stored in `http.headers`,
`observedValue`, query strings, and body excerpts.

- **Why it matters:** Phase 2 security review requires no token/secret
  exposure anywhere in storage or output; VAPT evidence contains far more
  HTTP surface than DPDP findings.
- **Options:** blocklist of header names + secret-pattern regexes + query
  redaction + truncated excerpts; vs allowlist of safe fields.
- **Recommendation:** allowlist for headers (only declared safe headers, e.g.
  `Server`, `Content-Security-Policy`, `Strict-Transport-Security`) +
  blocklist fallback + query-string redaction + excerpt truncation. Lock the
  policy down with tests before the engine ships.

## 10. Backend scan-job id correlation

**Question:** when the backend registers a VAPT scan and returns its own job
id, is that id stored on the CLI scan state (like DPDP `scanJobId` today) or
is the CLI `scanId` used end-to-end?

- **Why it matters:** affects `status`/`submit` correlation and the backend
  contract.
- **Recommendation:** mirror DPDP — store the backend job id on the scan
  state and send the CLI `scanId` as a correlation field in both directions.
  No decision needed before implementation beyond confirming the backend will
  return an id.
