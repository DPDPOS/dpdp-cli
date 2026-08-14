# Example End-to-End VAPT Scan Lifecycle

> Design document — illustrative walkthrough of the proposed contract, not a
> transcript of a working feature.

## Scenario

An organization authorizes a defensive web assessment of
`https://app.example.com` (pre-production) with a web-baseline profile. The
assessment is created in the DPDPOS frontend; the CLI is configured and
logged in exactly as today (`dpdp login`, `dpdp configure`).

## Timeline

### 1. Define the authorized scope

```
dpdp vapt scope \
  --assessment <uuid> \
  --target https://app.example.com --target-type URL \
  --exclude https://app.example.com/admin \
  --profile web-baseline \
  --mode active-safe \
  --authorized-by "ashlesh@corp" --purpose "pre-prod release assessment"
```

- Validated + stored: `config/vapt/<assessmentId>.json`
  `{ target, excludedTargets, allowedPorts: [443], profile: "web-baseline",
  mode: "active-safe", scopeVersion: 1, authorization: { … } }`.
- Output: scope summary incl. `scopeVersion: 1`.
- No scan possible until this exists (fail closed).

### 2. Run the scan

```
dpdp vapt scan
```

Engine flow:

1. Load scope (v1) + profile `web-baseline` (e.g. 12 checks across
   `http-headers`, `tls`, `auth`, `info`).
2. **Scope gate:** target covered, `/admin` excluded, port 443 allowed →
   proceed; otherwise refuse with an actionable error.
3. Create scan state: `scan-<uuid>`, `capability: "VAPT"`, status `running`,
   config snapshot + scopeVersion recorded.
4. Execute checks (concurrency/rate limits applied; per-check timeout;
   cancellation signal checked between checks). Example outcomes:
   - `tls/weak-cipher` → TLS 1.0 + `TLS_RSA_WITH_AES_128_CBC_SHA` observed
     (evidence item `kind: tls`).
   - `http-headers/missing-hsts` → response on `/` lacks `Strict-Transport-Security`
     (evidence item `kind: http`, headers sanitized — no auth/cookie values).
   - `auth/session-cookie-flags` → session cookie without `Secure`/`HttpOnly`
     (evidence item `kind: http`).
   - 9 other checks pass or are skipped (recorded in `checks.skipped` with
     reasons, e.g. "requires auth", "passive-only in active-safe").
5. Normalize → 3 `VaptFinding` records (severities: HIGH, MEDIUM, MEDIUM;
   `provenance.source: "local-check"`), each with `evidenceRefs`.
6. Deduplicate on `target-identity | checkId | endpoint`.
7. Persist (local-first, before any backend call):
   - `state/scans/scan-<uuid>.json` — status `completed`, checks
     executed/skipped, findingsCount: 3, submission `pending`.
   - `evidence/scan-<uuid>.json` — envelope
     `{ scanId, capability: "VAPT", schemaVersion: 2, findings: […], evidence: […] }`.
   - `evidence/artifacts/scan-<uuid>/art-<uuid>` — e.g. a TLS transcript dump
     (sha256 recorded in its `.json` metadata).
8. `state/current-scan.json` → `{ scanId: "scan-<uuid>" }`.
9. Output: scan id, checks 12 (3 executed findings + 9 clean/skipped),
   severity counts, duration.

### 3. Preview offline

```
dpdp vapt findings
```

Reads `evidence/scan-<uuid>.json` — no backend, no config/credentials
required. Prints 3 findings with normalized severities + provenance.

### 4. Submit

```
dpdp vapt submit
```

1. Register scan with backend → backend `scanJobId` stored on the scan state
   (same pattern as DPDP `scan`).
2. Submit findings (with evidence + artifact refs) and artifact content via
   the separate artifact channel.
3. Mark `submission: { state: "submitted", submittedAt }`.

### 5. Track

```
dpdp vapt status
```

Polls backend scan status; prints execution + submission state.

### 6. Failure / retry path (local-first semantics)

If step 4 fails mid-way (network down, backend 500):

- `submission: { state: "failed", error: "…" }` is recorded on the scan
  state; **evidence and artifacts remain on disk**.
- `dpdp vapt findings` still works.
- `dpdp vapt submit` retries **without rescanning** — the same stored
  artifacts are resubmitted. This mirrors the Phase 2 DPDP flow exactly.

## State transitions in this example

```
scope:      (none) → v1
scan:       queued → running → completed
submission: pending → submitted   (or: pending → failed → submitted on retry)
```

## What the backend received (conceptual)

- A registered VAPT scan for assessment `<uuid>`: target, scope summary,
  profile/config snapshot, provenance, timestamps.
- 3 normalized findings (category, severity, target, description, evidence +
  artifact refs, remediation, references, provenance).
- 1 artifact (metadata + bytes), integrity-checked via sha256.
