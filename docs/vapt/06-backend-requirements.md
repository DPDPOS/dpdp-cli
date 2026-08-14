# VAPT Backend Requirements

> Design document — no endpoints, URL paths or HTTP payloads are chosen here.
> This section states, from the CLI/assessment perspective, what the backend
> will eventually need to receive. Existing backend endpoints, auth and
> payloads are untouched by this phase.

## 1. Principle

The backend currently has **no VAPT implementation**, and the existing
DPDP endpoints (`POST …/cli/scans`, `POST …/cli/evidence/batch`,
`GET …/cli/scans/{id}`, `GET …/report`) are DPDP-specific. VAPT support will
follow the same architectural pattern (assessment-scoped, CLI token auth,
`cli/scans`-style resources) but is a separate capability. This document
defines **what** the backend must accept, not **how** it is exposed.

## 2. Conceptual operations

### 2.1 Register / create a VAPT scan

The backend must accept the creation of a VAPT scan and return a backend scan
job id (analogous to the DPDP flow: `scan` creates a job, `status` polls it).

Required data from the CLI:

- `assessmentId` (backend-owned assessment or a CLI-created VAPT assessment)
- `scanId` (CLI-local id, for correlation)
- target + scope summary (target type, value, hostname/ip/url/port/protocol,
  included/excluded counts, scope version)
- profile + config snapshot (profile name, check categories, mode,
  timeout/concurrency/rate, tool config)
- provenance: cli version, engine version, check catalog version
- timestamps: startedAt / completedAt, durationMs

### 2.2 Submit findings

The backend must accept a batch of normalized VAPT findings for a registered
scan.

Required per finding (see finding model):

- identity: `findingId`, `checkId`
- classification: `category`, normalized `severity` (INFO…CRITICAL), `title`,
  optional `findingCode`
- target: hostname/ip/url/port/protocol/endpoint as applicable
- description + impact
- evidence references (`evidenceRefs`, `artifactRefs`)
- remediation: recommendation, remediationPriority
- references: standards, advisories, CWEs, CVEs when known
- provenance: scanner, scannerVersion, checkVersion, source, timestamps

Contract notes for the backend:

- Severity arrives **pre-normalized** to the 5-point model; the mapping table
  lives in the CLI/check catalog (versioned). The backend does not need to
  know vendor-specific severity scales.
- Findings are **findings + evidence refs only** — no inline raw dumps.
- The backend must accept `schemaVersion`/`capability` markers so it can
  distinguish VAPT evidence from DPDP evidence.

### 2.3 Submit artifacts

The backend must accept raw artifacts (logs, dumps, transcripts,
screenshots) as a **separate channel** from findings — potentially large,
submitted in chunks.

Required per artifact: `artifactId`, `scanId`, kind, mimeType, sizeBytes,
`sha256` (integrity), capturedAt, plus the bytes/stream. Artifact metadata is
submitted with findings; artifact content is submitted separately.

### 2.4 Retrieve scan status

The backend must expose scan execution + submission status so `dpdp vapt
status` can poll (mirroring the DPDP `status` command). State it must be able
to represent: queued/running/completed/failed/cancelled, started/completed
timestamps, duration, checks executed/skipped, findings count, submission
state.

### 2.5 (Later) Evaluation & reporting

Out of scope for this contract: the backend may later evaluate VAPT findings
against DPDP controls and produce compliance output. The CLI ships enough
classification (category, severity, target, provenance, references) to
support that mapping without a payload redesign.

## 3. What the backend must NEVER receive

- Token/credentials of any kind (dpdp CLI token is already auth-only; VAPT
  target credentials and HTTP `Authorization`/`Cookie`/`Set-Cookie` header
  values are stripped client-side by the sanitization policy).
- Secret-pattern matches from `observedValue`/body excerpts.
- Raw scanner output beyond declared artifact content (and never inside the
  findings payload).

## 4. Explicit non-goals for this phase

- No endpoint paths, HTTP payload schemas, or database tables are designed
  here (implementation phase decides those, constrained by this contract).
- No compliance scoring, DPDP control mapping, or PASS/FAIL evaluation —
  backend-side, later phase.
- No changes to existing DPDP endpoints, auth protocol, `Finding` fields,
  `findingType` values, or evidence batch payload.
