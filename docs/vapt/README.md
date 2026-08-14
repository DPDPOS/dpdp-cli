# VAPT Capability — Design Documents

This directory defines the **data and execution contract** for a future
authorized VAPT (Vulnerability Assessment and Penetration Testing) capability
of `dpdp-cli`. It is a **design/documentation deliverable only**: no VAPT
code, backend APIs, dependencies, or database migrations were created or
modified as part of this phase.

## Purpose

The DPDPOS backend currently has **no VAPT implementation**. Before either
the CLI VAPT capability or backend support is built, we need to answer:

> What information must the CLI collect and produce so that the backend can
> later store, evaluate, report and track a VAPT assessment?

These documents define that contract from the CLI/assessment perspective.
They deliberately stop short of database tables, HTTP endpoints and payload
shapes.

## Reading order

| Doc | Content |
|---|---|
| [`01-architecture.md`](./01-architecture.md) | Where VAPT fits in the existing CLI; module boundary; execution flow; DPDP relationship; safety model |
| [`02-data-contract.md`](./02-data-contract.md) | Assessment / Scan / Target / Scope / Config / Execution-state / Check models |
| [`03-finding-evidence-model.md`](./03-finding-evidence-model.md) | Finding, Evidence, Raw Artifact models; severity normalization; field rationale |
| [`04-cli-command-proposal.md`](./04-cli-command-proposal.md) | Conceptual `dpdp vapt …` command tree (purpose, inputs, state, output) |
| [`05-storage-mapping.md`](./05-storage-mapping.md) | How VAPT maps onto the Phase 2 storage architecture; genuine gaps |
| [`06-backend-requirements.md`](./06-backend-requirements.md) | What the backend will eventually need to receive (conceptual operations only) |
| [`07-example-lifecycle.md`](./07-example-lifecycle.md) | End-to-end VAPT scan lifecycle with a concrete example, incl. failure/retry |
| [`08-open-decisions.md`](./08-open-decisions.md) | Decisions that must be made before implementation |

## Relationship to existing documentation

- **`HANDOFF_PHASE1.md`** — source of truth for the scanner pipeline
  (`ScannerEngine`, `Analyzer`, `ScanContext`, `AnalyzerRegistry`,
  `EvidenceBundle`, normalization, deduplication).
- **`HANDOFF_PHASE2.md`** — source of truth for local storage
  (`openStorage`, the four stores, schema versioning v1→v2, migration,
  atomic writes, path safety). Its §22 sketch ("How VAPT can later fit") is
  refined here; the storage design itself is not redesigned.
- **`README.md`** — user-facing CLI usage; unchanged except a pointer to
  this directory.

Existing documents were **not rewritten** — they are phase snapshots. This
directory adds the VAPT-specific contract on top of them.

## Ground rules for this capability (from the phase brief)

- VAPT is a **bounded capability** of the CLI, not a feature of the DPDP
  source scanner.
- VAPT produces **security findings + technical evidence**. It does not
  produce DPDP PASS/FAIL or compliance scores; the backend may later map
  relevant findings to DPDP controls.
- The CLI must only ever operate against **explicitly authorized targets**.
- Nothing here authorizes or describes exploitation functionality — the goal
  is an authorized, defensive security assessment capability.
