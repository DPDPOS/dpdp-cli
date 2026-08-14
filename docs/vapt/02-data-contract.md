# VAPT Data Contract

> Design document — nothing here is implemented. This defines the
> information model required to represent an authorized VAPT assessment.
> Database tables, HTTP endpoints and payloads are out of scope (see
> `06-backend-requirements.md`).

## 1. Core concepts

Four distinct concepts are never collapsed:

1. **Assessment** — the overall authorized VAPT engagement.
2. **Scan** — one execution/run of the assessment.
3. **Finding** — a security issue discovered during a scan.
4. **Evidence** — the technical observation supporting a finding (plus
   separately-stored **raw artifacts**).

## 2. Assessment model

The overall engagement. Created once per authorized scope; long-lived;
contains no per-run data.

```ts
type VaptAssessment = {
  assessmentId: string;            // stable id (safe: ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$)
  type: "VAPT";                    // distinguishes from DPDP file assessments
  target: VaptTarget;              // primary target
  scope: VaptScope;                // the authorization contract (required)
  status: "draft" | "active" | "completed" | "archived";
  createdAt: string;               // ISO-8601
  updatedAt: string;
  // associated scan ids (history), maintained by the CLI
  scanIds: string[];
};
```

Rationale: the assessment holds everything that is **stable across runs**
(target, scope, authorization metadata); scans hold everything that is
**per-run**. This is what lets the backend later store, evaluate, report and
track the assessment without duplicating per-scan data.

## 3. Target and scope

### Target types

```ts
type VaptTargetType = "URL" | "HOSTNAME" | "IP" | "APPLICATION" | "SERVICE";

type VaptTarget = {
  targetType: VaptTargetType;
  value: string;                   // e.g. https://app.example.com, api.example.com, 10.0.0.5:8443
  // optional additional identifiers, populated when known
  hostname?: string;
  ip?: string;
  url?: string;
  port?: number;
  protocol?: string;               // http, https, tls, ssh, ...
  application?: string;            // app/service identifier when targetType = APPLICATION
};
```

### Scope (the authorization contract)

Explicit, required, fail-closed:

```ts
type VaptScope = {
  scopeVersion: number;            // bumped on every edit → auditability
  target: VaptTarget;              // primary target
  includedTargets: VaptTarget[];   // additional authorized targets
  excludedTargets: VaptTarget[];   // never contacted; enforced at engine level
  allowedPorts?: number[];         // when set, only these ports may be contacted
  allowedServices?: string[];      // when set, only these services may be assessed
  profile: string;                 // named scan profile (check set + defaults)
  mode: "passive" | "active-safe" | "active";
  authorization: {
    authorizedBy: string;          // who authorized (user/org identifier)
    authorizedAt: string;
    expiresAt?: string;            // optional authorization expiry
    purpose: string;               // e.g. "pre-production release assessment"
    reference?: string;            // ticket/contract reference
  };
};
```

Rules:

- A scan **refuses to start without a validated scope** (no default scope).
- Exclusions take precedence over inclusions and are enforced **once, in the
  engine**, not per check.
- If `allowedPorts`/`allowedServices` are set, contacting anything outside
  them is an engine-level refusal.
- The scope snapshot is recorded with each scan so audits can show exactly
  what was authorized at run time.

## 4. Scan configuration (reproducibility)

Separates **user configuration** (the scan plan) from **generated results**
(scan state, findings, evidence).

```ts
type VaptScanConfig = {
  profile: string;                 // named check set
  checkCategories: string[];       // e.g. ["tls", "http-headers", "auth"]
  mode: "passive" | "active-safe" | "active";
  timeoutMs: number;               // per-check timeout
  concurrency: number;             // max parallel checks
  ratePerSecond: number;           // request rate limit
  auth?: VaptAuthRef;              // optional; see below
  safeMode: boolean;               // true by default (non-destructive)
  toolConfig: {                    // scanner/tool knobs + version pins
    engineVersion: string;
    checkCatalogVersion: string;
    [key: string]: unknown;
  };
};
```

- **Auth** is a *reference*, never inline secrets: `VaptAuthRef = { kind:
  "none" | "header" | "basic" | "session"; credentialId?: string }`. Where
  secret material lives is an open decision (see `08-open-decisions.md`), but
  it is never part of this config object and never part of any submitted
  payload.
- The full config snapshot is persisted with the scan (as part of scan state
  or a config artifact) so any scan can be reproduced.

## 5. Scan execution state

The per-run record. Modeled after the Phase 2 `ScanState`, extended for
long-running remote scans:

```ts
type VaptScanStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

type VaptScanState = {
  scanId: string;                  // safe id, e.g. scan-<uuid>
  assessmentId: string;
  capability: "VAPT";
  config: VaptScanConfig;          // snapshot for reproducibility
  scopeVersion: number;            // which scope revision this run used
  status: VaptScanStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  scanner: { cliVersion: string; engineVersion: string; checkCatalogVersion: string };
  checks: {
    executed: string[];            // check ids
    skipped: { checkId: string; reason: string }[];
  };
  error?: { code: string; message: string };   // no secrets in message
  cancellation?: { requestedAt: string; reason: string };
  submission: {                    // mirrors Phase 2 SubmissionState
    state: "pending" | "submitted" | "failed";
    submittedAt?: string;
    error?: string;
  };
  evidenceFile?: string;           // relative artifact path (Phase 2 convention)
  findingsCount?: number;
};
```

Status lifecycle:

```
queued → running → completed
            ├──> failed        (unrecoverable engine error)
            └──> cancelled     (cooperative cancellation)
```

The backend job id from Phase 2 (`scanJobId`) is added when the backend
registers the scan, exactly as the DPDP flow does today.

## 6. Check model

Checks are **declarative data** so new checks can be added without modifying
the VAPT engine:

```ts
type VaptCheck = {
  checkId: string;                 // stable, e.g. "tls/weak-cipher"
  name: string;                    // human-readable
  category: string;                // e.g. "tls", "http-headers", "auth", "info"
  description: string;
  supportedTargetTypes: VaptTargetType[];
  defaultSeverity?: Severity;      // for checks that cannot observe severity
  version: string;                 // check version (per-check provenance)
  executionRequirements?: {
    protocol?: string[];           // e.g. ["https"]
    needsAuth?: boolean;
    passiveOnly?: boolean;         // checks that must never be active
    safeOnly?: boolean;            // never runs outside safe mode
  };
};
```

- The **check registry** maps profile → ordered check list and validates
  `supportedTargetTypes` against the scope before execution.
- Check catalog version is recorded per scan (provenance).

## 7. Where each concept lives in the codebase (contract-level)

| Concept | Phase 1/2 home | VAPT addition |
|---|---|---|
| Assessment | `config/config.json` holds a **single** `assessmentId` | per-assessment VAPT config/scope (gap — see storage doc) |
| Scan state | `state/scans/<scanId>.json` (`ScanStateStore`) | capability-tagged or parallel state |
| Findings | `evidence/<scanId>.json` (`EvidenceStore`, `schemaVersion: 1`) | VAPT finding family with its own schema version |
| Evidence / artifacts | single JSON artifact per scan | structured evidence items + separate raw artifact store (gap) |
| Transport | `src/transport/api.ts` | unchanged, same auth |

See [`05-storage-mapping.md`](./05-storage-mapping.md) for the full mapping.
