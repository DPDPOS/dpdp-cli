# VAPT Finding & Evidence Model

> Design document — nothing here is implemented. Every proposed field has a
> stated reason; no fields are included merely because security tools commonly
> have them.

## 1. Finding model

```ts
type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

type VaptFinding = {
  // IDENTITY
  findingId: string;               // local, safe id, e.g. finding-<uuid>
  checkId: string;                 // which check produced it (→ check version via catalog)

  // CLASSIFICATION
  category: string;                // check category, e.g. "tls"
  severity: Severity;              // NORMALIZED (see §3)
  title: string;                   // short human summary, e.g. "TLS 1.0 enabled"
  findingCode?: string;            // optional stable machine code, e.g. "TLS-010"

  // TARGET
  target: {
    targetType: VaptTargetType;
    hostname?: string;
    ip?: string;
    url?: string;
    port?: number;
    protocol?: string;
    endpoint?: string;             // path/resource, e.g. "/login"
  };

  // DESCRIPTION
  description: string;             // what was observed and why it matters
  impact?: string;                 // business/technical impact

  // EVIDENCE (references, not inline blobs)
  evidenceRefs: string[];          // evidence item ids (see §4)
  artifactRefs?: string[];         // raw artifact ids (see §5), when present
  observedAt: string;              // ISO-8601

  // REMEDIATION
  recommendation?: string;
  remediationPriority?: "immediate" | "scheduled" | "informational";

  // REFERENCES
  references?: {
    standards?: string[];          // e.g. ["OWASP ASVS 4.0.3", "PCI-DSS 4.0"]
    advisories?: string[];         // e.g. ["CVE-2023-XXXX advisory", vendor bulletins]
    cwes?: string[];               // e.g. ["CWE-327"]
    cves?: string[];               // e.g. ["CVE-2023-XXXX"]
  };

  // PROVENANCE
  provenance: {
    scanner: string;               // e.g. "dpdp-cli"
    scannerVersion: string;
    checkId: string;
    checkVersion: string;
    source: "local-check" | "external-tool-import";  // how the finding entered the CLI
    submittedAt?: string;
  };
};
```

### Field rationale

| Group | Field | Reason |
|---|---|---|
| Identity | `findingId`, `checkId` | Stable local identity + traceability to the exact check that fired |
| Classification | `category`, `severity`, `title`, `findingCode` | Grouping, prioritization, human reading, and a stable machine code for backend mapping. A separate free-form `type` is deliberately **not** included — `checkId` already identifies the check type and `category` groups it; a redundant `type` would add a third classification axis with no consumer |
| Target | hostname/ip/url/port/protocol/endpoint | Locating the issue and correlating with scope; only the fields applicable to the target type are populated |
| Description | `description`, `impact` | Human understanding and prioritization |
| Evidence | `evidenceRefs`, `artifactRefs`, `observedAt` | Keeps findings small; links to separately-stored proof; timestamp for ordering |
| Remediation | `recommendation`, `remediationPriority` | Actionable output for backend reporting and triage |
| References | standards/advisories/cwes/cves | Enrichment, prioritization, and future DPDP-control mapping hooks |
| Provenance | scanner/version/checkVersion/source | Auditability + reproducibility (Phase 2 requirement) |

## 2. Finding vs Evidence vs Raw Artifact

- **Finding** — the structured, small, backend-submittable record (above).
- **Evidence item** — a structured technical observation supporting a finding
  (small, JSON, stored with the finding artifact).
- **Raw artifact** — large or binary scanner output (logs, TLS transcripts,
  HTTP dumps, screenshots) stored separately and referenced by id + sha256;
  never loaded eagerly.

The finding artifact stays small; raw artifacts can grow without bloating the
primary record or the backend payload.

## 3. Severity normalization

- **Normalized model:** `INFO | LOW | MEDIUM | HIGH | CRITICAL` (5-point).
  Reason: ordinal ranking is required by backend reporting, remediation
  prioritization, and future control mapping; this is the de-facto standard
  scale.
- **Scanner-specific severity → DPDPOS model:** a per-scanner mapping table
  (e.g. Nessus `Critical/High/Medium/Low/Info`, Burp `High/Medium/Low/Info`,
  custom `P0…P4`) maps to the 5-point model. The mapping table lives with the
  check catalog and is versioned with it.
- **Unmapped values:** never silently upgraded or dropped. An unmapped value
  produces a normalization warning, the finding is flagged
  (`severitySource: "unmapped"`) and assigned `LOW` (fail toward
  non-inflation). See open decision in `08-open-decisions.md`.
- **Severity ≠ compliance score.** VAPT severity describes the technical
  impact of one finding; DPDP compliance evaluation is a separate, backend-side
  concept. Nothing in the CLI computes a compliance score.

## 4. Evidence item model

```ts
type EvidenceItem = {
  evidenceId: string;              // ev-<uuid>
  findingId: string;               // back-reference
  kind: "observation" | "http" | "tls" | "config" | "service";
  observedValue?: string;          // the key observed fact (short)
  http?: {                         // only when kind = "http"; SANITIZED
    method: string;
    url: string;                   // no query-string secrets by policy
    status: number;
    headers: { name: string; value: string }[];  // auth/cookie/set-cookie NEVER stored
    bodyExcerpt?: string;          // truncated, secrets policy applies
  };
  tls?: {                          // only when kind = "tls"
    version: string;               // e.g. "TLSv1.2"
    cipherSuite?: string;
    certificateIssuer?: string;
    certificateSubject?: string;
    validationResult?: string;     // e.g. "expired", "self-signed", "valid"
  };
  config?: { source: string; key?: string; value?: string };  // config observation
  hashes?: Record<string, string>; // e.g. { "sha256": "…" } for observed artifacts
  capturedAt: string;              // ISO-8601
};
```

**Sanitization policy (engine-level, not optional):** `Authorization`,
`Cookie`, `Set-Cookie`, and any header matching a secret-name pattern are
never stored in `http.headers` or any `observedValue`; query strings are
redacted; body excerpts are truncated and scanned for secret patterns. This
mirrors the Phase 2 rule that the dpdp token never leaves
`credentials/credentials.json`.

## 5. Raw artifact model

```ts
type ArtifactRef = {
  artifactId: string;              // art-<uuid>
  scanId: string;
  kind: "log" | "dump" | "screenshot" | "transcript" | "other";
  mimeType: string;
  sizeBytes: number;
  sha256: string;                  // integrity check for storage + submission
  storedPath: string;              // relative to storage root (path-safe id)
  capturedAt: string;
};
```

Artifacts are stored via a future artifact store (see storage doc) and are
referenced from findings by `artifactRefs`. The backend contract treats
artifacts as a separate submission channel from findings (large payloads).

## 6. Deduplication

Phase 1 dedupes DPDP findings on `location|findingType`. VAPT findings have no
`location` string; the proposed VAPT dedup key is:

```
target-identity | checkId | endpoint
```

(e.g. `app.example.com:443 | tls/weak-cipher | /login`). A second scan of the
same target with the same check and endpoint supersedes the previous finding
record rather than duplicating it. Exact semantics (first-wins vs
last-wins per scan) are an open decision; deduplication remains a separate
pipeline responsibility exactly as in Phase 1.
