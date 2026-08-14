# Phase 4 Handoff Report — Working Passive VAPT Capability

Phases 1 (scanner pipeline), 2 (storage), 3 (VAPT design) are complete. This
phase implements the first working, local, **passive** VAPT capability inside
the existing CLI, following the Phase 3 design (`docs/vapt/`).

---

## 1. Summary

A bounded `src/vapt/` capability was implemented:

```
dpdp vapt scope      → validates + persists the authorized scope (fail closed)
dpdp vapt scan       → scope gate → passive checks → findings + evidence → local storage
dpdp vapt findings   → offline preview of the latest (or --scan <id>) findings
dpdp vapt submit     → honest "not connected" + exact future payload (no fake API calls)
dpdp vapt status     → local scan state (backend polling not connected)
dpdp vapt cancel     → clear "not available in this build" (in-process scans)
```

Four real passive checks: HTTPS availability, TLS certificate validity
(expiry / not-yet-valid / self-signed / hostname mismatch), deprecated TLS
protocol version, and missing security headers (HSTS, CSP, X-Content-Type-
Options, X-Frame-Options, Referrer-Policy). Findings are structured
(`VaptFinding`), separate from structured evidence items, with severity
normalization, provenance and within-scan deduplication. Everything persists
through the Phase 2 storage layer (atomic writes, safe ids, per-scan
artifacts) — evidence survives process exit and backend absence.

**Build/test:** clean `npm install` ✓, `npm run build` ✓, **127/127 tests**
(64 new) ✓. Manual demo against a controlled local HTTP target ✓.

## 2. Final VAPT folder structure

```
src/vapt/
├── engine/
│   ├── vapt-engine.ts      # VaptEngine: resolve → scope gate → checks → normalize → dedup
│   └── types.ts            # VaptScanSummary, VaptIssue, VaptScanStateExtra
├── scope/
│   ├── types.ts            # VaptTargetType, VaptTarget, VaptMode, VaptScope
│   └── validate.ts         # parseScope, parseTarget, resolveTarget, assertTargetInScope (gate)
├── checks/
│   ├── types.ts            # VaptCheck, CheckContext, CheckResult
│   ├── registry.ts         # CheckRegistry (register/get/list/forTargetType)
│   ├── tls.ts              # https-availability, certificate-validity, protocol-version
│   └── http-headers.ts     # security-headers
├── collectors/
│   ├── types.ts            # HttpCollector, TlsCollector, observations
│   ├── http.ts             # NodeHttpCollector (fetch, redirect: manual, header allowlist)
│   └── tls.ts              # NodeTlsCollector (tls.connect observation, no validation failure)
├── findings/
│   ├── types.ts            # Severity, VaptFinding, EvidenceItem, VAPT_EVIDENCE_SCHEMA_VERSION=2
│   ├── severity.ts         # normalizeSeverity, maxSeverity
│   ├── normalize.ts        # stamps findingId/evidence ids/provenance/timestamps
│   ├── deduplicate.ts      # target|checkId|endpoint, within-scan, first wins
│   └── evidence.ts         # loadVaptEvidence, latestVaptScanId
├── profile/
│   ├── types.ts            # VaptScanConfig
│   └── default.ts          # createDefaultVaptProfile() — composition root + versions
└── transport/
    └── submission.ts       # buildVaptSubmissionPayload — typed future-backend payload
```

Plus: `src/storage/vapt-config-store.ts` (new), `src/cli/commands/vapt/*`
(6 command files + group), and small backward-compatible extensions to
`src/storage/{fs-utils,index,scan-state-store,evidence-store}.ts` and
`src/shared/errors.ts`.

## 3. VAPT execution flow

```
dpdp vapt scan (cli/commands/vapt/scan.ts)
  └─ openStorage → requireConfig → load scope (parseScope, fail closed if none)
  └─ scans.create({ capability: "VAPT", status: "running", extra: { scope, config } })
  └─ VaptEngine.run(scope, config)
       ├─ resolveTarget → assertTargetInScope(host, httpPort) + (host, tlsPort)   [fail closed]
       ├─ for each check in registry.forTargetType(targetType):
       │     protocol filter → check.run(ctx) → CheckResult
       │     failures → VaptIssue (non-fatal) | skipped → recorded with reason
       ├─ normalizeFinding (ids, provenance, severity fallback, evidence ids)
       ├─ deduplicateFindings (target|checkId|endpoint, first wins)
       └─ summary { checksExecuted, checksSkipped, findings, evidence, durationMs, issues }
  └─ evidence.save(scanId, { capability: "VAPT", schemaVersion: 2, vaptFindings, evidence })
  └─ scans.update(status: completed, extra: checks/duration/findingsCount)
dpdp vapt findings → latestVaptScanId → evidence.load → JSON + Total
```

## 4. Scope model

`VaptScope`: `scopeVersion`, `target` (URL | HOSTNAME | IP | APPLICATION |
SERVICE with value/hostname/ip/url/port/protocol), `includedTargets`,
`excludedTargets`, `allowedPorts`, `allowedServices`, `profile`, `mode`
(passive | active-safe | active), and `authorization`
(`authorizedBy`, `authorizedAt`, `expiresAt?`, `purpose`, `reference?`).
`parseScope` validates everything with clear `vapt.scope` errors; the scope
command requires `--target`, `--target-type`, `--authorized-by`, `--purpose`.

## 5. Scope enforcement

- No scope → `dpdp vapt scan` refuses ("No VAPT scope configured …").
- Engine calls `assertTargetInScope` for **both** the HTTP port and the TLS
  port **before any collector runs**; any failure throws `vapt.out_of_scope`
  with zero network I/O (asserted by tests via call-recording collectors).
- Exclusions are host+port level (the target model has no path); excluding a
  path of the primary host excludes the whole host — fail-safe direction,
  documented limitation.
- `allowedPorts` enforced at engine level; non-passive modes refused in this
  build ("passive-only").

## 6. VAPT config storage

`src/storage/vapt-config-store.ts` → `~/.dpdp/config/vapt/<assessmentId>.json`
(`{ assessmentId, scopeVersion, updatedAt, scope }`). Assessment ids pass
`assertSafeId` before path use. Scope payload is stored opaquely and
re-validated by `parseScope` on load. Same atomic writes / tagged errors as
Phase 2. Exposed as `storage.vaptConfig` on the `Storage` composition.

## 7. Check interface

```ts
type VaptCheck = {
  checkId: string; name: string; category: string; description: string;
  supportedTargetTypes: VaptTargetType[]; defaultSeverity: Severity; version: string;
  executionRequirements?: { protocol?: string[]; needsAuth?: boolean; passiveOnly?: boolean; safeOnly?: boolean };
  run(context: CheckContext): Promise<CheckResult>;   // CheckResult = { findings: RawVaptFinding[]; skipped?: { reason } }
};
```

Checks produce **structured** `RawVaptFinding`s with inline evidence drafts —
never plain strings. Context carries the resolved target, ports, scheme,
baseUrl, config, and injectable collectors.

## 8. Check registry

`CheckRegistry` (register/get/unregister/list/forTargetType) mirrors the
Phase 1 `AnalyzerRegistry`: checks are registered at composition time in
`createDefaultVaptProfile()`; the engine executes whatever is registered.
New check = new data object + register + tests; **no engine changes**. No
dynamic plugin system.

## 9. Checks implemented (all passive, non-destructive)

| checkId | Reports when | Severity |
|---|---|---|
| `tls/https-availability` | TLS handshake fails on the service port | MEDIUM |
| `tls/certificate-validity` | expired / not-yet-valid / self-signed / hostname mismatch | HIGH / MEDIUM |
| `tls/protocol-version` | negotiates TLSv1 or TLSv1.1 | MEDIUM |
| `http/security-headers` | any of HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy missing | LOW (INFO for Referrer-Policy) |

Each check emits **at most one finding per target/endpoint** (missing headers
are aggregated into one finding; certificate issues into one finding with the
worst severity), which keeps the Phase 3 dedup key meaningful.

## 10. Finding model

`VaptFinding` per Phase 3: findingId, checkId, category, severity, title,
findingCode (optional), target (hostname/ip/url/port/protocol/endpoint),
description, impact?, evidenceRefs, artifactRefs?, observedAt,
recommendation?, remediationPriority?, references?, provenance
(scanner, scannerVersion, checkId, checkVersion, source). Never the DPDP
`Finding` type.

## 11. Evidence model

`EvidenceItem`: evidenceId, findingId (back-ref), kind
(observation/http/tls/config/service), observedValue, http (method/url/status
/headers), tls (version/cipher/certificate), config, hashes, capturedAt.
**Sanitization:** the HTTP collector records only an allowlist of headers
(never Authorization/Cookie/Set-Cookie), stores no request/response bodies,
uses `redirect: "manual"` so redirects are never followed (could leave scope),
and identifies itself with a `dpdp-cli-vapt` User-Agent. Raw artifacts are
out of scope for this slice (no check produces them).

## 12. Severity normalization

`normalizeSeverity` maps to INFO | LOW | MEDIUM | HIGH | CRITICAL; unmapped
values fall back to the check's `defaultSeverity` and are flagged in the
description. Checks emit typed severities, so the fallback only matters for
future external-tool import. No compliance score is computed — VAPT severity
is independent of DPDP compliance scoring.

## 13. Deduplication

`deduplicateFindings`: key `target-identity | checkId | endpoint`, **within a
scan**, first wins, order preserved. Different hosts/targets are never
collapsed (hostname/IP is part of the key).

## 14. CLI commands

All six registered under `dpdp vapt` (thin actions, engine has no Commander
dependency):

- `scope` — required `--target`, `--target-type`; optional `--include`,
  `--exclude`, `--port`, `--profile`, `--mode`, `--expires`; required
  `--authorized-by`, `--purpose`. Validates, persists (bumps scopeVersion),
  prints a safe summary.
- `scan` — loads scope (fail closed), creates running scan state, executes
  checks, persists evidence + completed state; optional `--mode`, `--profile`,
  `--timeout-ms`; non-passive modes refused.
- `findings` — `--scan <id>` optional; JSON + `Total:` (mirrors `dpdp
  evidence`).
- `submit` / `status` — honest "not connected yet" + local state / the exact
  typed future payload; **no fake requests**.
- `cancel` — clear "not available in this build".

## 15. Storage integration

- `config/vapt/<assessmentId>.json` via new `VaptConfigStore`.
- `ScanState` gained optional `capability?: "DPDP" | "VAPT"` and `extra?:
  Record<string, unknown>` (VAPT execution state owned by the vapt module);
  `ScanStatus` widened with queued/running/completed/cancelled. DPDP scan
  states are unchanged on disk (no migration; verified by test).
- `EvidenceStore` envelope gained `capability`, `vaptFindings`, `evidence`
  with `schemaVersion: 2`; DPDP artifacts keep `findings` + schemaVersion 1
  and load with the exact old shape (existing tests unchanged and passing).
- VAPT **does not touch `state/current-scan.json`** — that pointer stays
  DPDP-owned, so `dpdp evidence`/`submit` never see VAPT data; `vapt findings`
  resolves the latest VAPT scan via `scans.list()` filtered by capability.
- Evidence survives failed scan state and process exit (tested).

## 16. Backend boundary

No backend VAPT APIs, no invented URLs, no fake requests. `src/vapt/transport/
submission.ts` builds a typed `VaptSubmissionPayload` (assessmentId, scanId,
target, scopeVersion, profile, mode, scanner versions, timestamps, findings,
evidence) per `docs/vapt/06-backend-requirements.md`; `vapt submit` prints it
with a "not connected" notice. Local execution is fully separated from
backend submission.

## 17. Safety controls

- Explicit scope required; engine gate before any network I/O (excluded /
  uncovered / disallowed port → `vapt.out_of_scope`, zero requests).
- Passive-only: no exploitation, brute force, credential attacks, payload
  injection, arbitrary port scanning or target discovery. Mode gate refuses
  non-passive.
- Per-request timeouts (`AbortSignal.timeout` / socket timeout), sequential
  execution (concurrency 1), redirects never followed, response bodies never
  stored, header allowlist, secrets never persisted or printed.
- Cooperative cancellation exists in the engine (AbortSignal checked between
  checks) but is unreachable from the CLI in this single-process build
  (documented; `cancel` is honest about it).

## 18. Tests (63 → 127)

| Area | File | Covers |
|---|---|---|
| Scope | `src/vapt/scope/validate.test.ts` | valid/invalid scopes, URL/IP parsing, ports, authorization, excluded/covered/port gate |
| Checks | `src/vapt/checks/checks.test.ts` | each check: findings, severity, evidence, skips, timeout/error handling, metadata |
| Engine | `src/vapt/engine/vapt-engine.test.ts` | normalization, provenance, dedup, failing check → issue, skips, no-checks error, cancellation, out-of-scope with zero collector calls |
| Findings | `src/vapt/findings/findings.test.ts` | severity normalization, normalizeFinding, dedup key semantics |
| Storage | `src/storage/vapt-storage.test.ts` | vapt config store, capability tagging (DPDP unaffected), evidence envelope, multiple scans, failed-scan preservation, path safety |
| CLI e2e | `src/cli/vapt-cli.test.ts` | real local HTTP server: scope→scan→findings, fail-closed without scope, invalid scope, mode gate, secrets never persisted, DPDP pointer isolation |

Mocked collectors everywhere possible; the CLI e2e uses a controlled local
server (including a `Set-Cookie` secret that must never be persisted).

## 19. Build / test results

```
rm -rf node_modules dist && npm install   ✓ (0 vulnerabilities)
npm run build                             ✓ (tsc clean; tests typecheck separately)
npm test                                  ✓ 127/127 (64 new)
Manual demo (temp HOME + local HTTP target on 127.0.0.1):
  scope → saved (scope v1); scan → 2 findings ([MEDIUM] HTTPS not available,
  [LOW] Security headers missing) + 2 skips; findings → structured JSON;
  status/submit → local state + future payload; storage tree correct;
  grep for Set-Cookie secret and dpdp token across evidence/state/config → clean
```

## 20. Manual verification (from §19)

Run end to end with a controlled local target, no production backend
dependency. DPDP commands remain intact (fresh-install guards, fixture scan,
existing 63 tests unchanged).

## 21. Known limitations

- **Passive-only, 4 checks, URL/HOSTNAME/IP targets** — APPLICATION/SERVICE
  scopes validate but no check supports them yet.
- **Exclusions are host+port level** (no path granularity); excluding a path
  of the primary host excludes the whole host (fail-safe).
- **Sequential execution** — `concurrency`/`ratePerSecond` are stored config
  fields; execution is serial (concurrency 1).
- **Cancellation is engine-level only** (AbortSignal between checks); the CLI
  `cancel` command cannot reach an in-process scan.
- **No raw artifact storage** — no check produces artifacts; `ArtifactStore`
  is future work.
- **TLS observation is inspection-only** — `rejectUnauthorized: false` is
  deliberate (we report invalid certs as findings, not failures); evidence
  includes cert dates/issuer/subject and self-signed/hostname-mismatch flags.
- **No auth-mode support** for targets (config has no auth field yet).
- **`vaptFindings` field name** in the stored envelope (vs `findings`) — a
  deliberate deviation from the Phase 3 sketch to keep the shared
  `EvidenceStore` type-safe for existing DPDP callers; the backend payload is
  unaffected (no VAPT backend exists yet).

## 22. What remains before backend integration

- Backend VAPT endpoints (register scan, submit findings, submit artifacts,
  status) per `docs/vapt/06-backend-requirements.md`, then wire
  `buildVaptSubmissionPayload` into a real `vapt submit` and `vapt status`.
- Artifact storage (`ArtifactStore`) before any check that needs raw output.
- Decide the open items in `docs/vapt/08-open-decisions.md` (multi-assessment
  model, target auth credentials, artifact limits, etc.).

## 23. Recommended next implementation step

Implement `dpdp vapt submit` against a real backend once the backend VAPT
contract exists: register the scan (reuse the DPDP `cli/scans` pattern),
submit the `VaptSubmissionPayload` findings + evidence, store the returned
job id on the scan state, and track `submission` state with local-first
retry — exactly the Phase 2 flow, with the transport boundary already in
place (`buildVaptSubmissionPayload`). In parallel, add the first
`ArtifactStore` so a future check (e.g. TLS transcript capture) has a home.

---

## IMPLEMENTED / PRESERVED / CHANGED / NOT IMPLEMENTED / KNOWN LIMITATIONS

**IMPLEMENTED (working):** `dpdp vapt scope|scan|findings|submit|status|cancel`;
scope model + fail-closed gate; 4 passive checks; VaptFinding/EvidenceItem
with severity normalization, provenance, dedup; VaptConfigStore; capability-
tagged scan state + evidence envelope (schemaVersion 2); submission payload
builder; 64 new tests.

**PRESERVED:** all 9 DPDP commands and their behavior; Phase 1 scanner
(ScannerEngine/Analyzer/ScanContext untouched); Phase 2 storage (four stores,
atomic writes, migration, path safety, 0600 credentials); DPDP evidence
schema + payload; `state/current-scan.json` DPDP ownership; all 63 prior
tests unchanged.

**CHANGED (intentional, backward compatible):** `ScanState` gained optional
`capability`/`extra`; `ScanStatus` widened; `EvidenceStore` envelope gained
`capability`/`vaptFindings`/`evidence`; storage tree gained
`config/vapt/`; `ERROR_CODES` gained `vapt.*` + `VaptError`; README updated.

**NOT IMPLEMENTED:** backend VAPT APIs, frontend UI, compliance scoring,
DPDP control mapping, active exploitation, vulnerability databases, CVE
enrichment, brute force, credential attacks, arbitrary network scanning,
dynamic plugin loading, AI analysis, raw artifact storage, target auth.

**KNOWN LIMITATIONS:** passive-only; host+port exclusions; sequential
execution; no CLI-reachable cancellation; APPLICATION/SERVICE targets
unsupported by checks; no artifacts; `vaptFindings` envelope field name.
