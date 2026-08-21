# AI Evidence Classification — Handoff

## 1. Objective

Add optional AI-powered post-processing to the DPDP compliance scanner so that each regex-matched finding can be classified as genuine evidence, a passing reference, or explicit negative evidence. This enriches the deterministic scanner output with contextual understanding without changing the backend submission contract.

## 2. Architectural Decision

```
dpdp scan --ai <path>
  │
  ├─ 1. Deterministic scanner runs (unchanged)
  │     └─ produces EvidenceBundle with Finding[]
  │
  ├─ 2. (optional) AI post-processing
  │     └─ classifyFindings() groups findings by source file,
  │        extracts 3-line context windows, sends to provider,
  │        validates returned classifications against input set
  │
  ├─ 3. AI result stored locally
  │     └─ ScanState.extra.aiContext = ClassificationResult
  │
  └─ 4. Backend submission (unchanged)
        └─ POST /api/v1/assessments/:id/cli/scans
           payload: { targetType, targetPath, cliVersion }
           (aiContext is NOT included)
```

Key principle: **AI is a local enrichment layer that never touches the submission payload.**

## 3. What AI Does

The AI classifies each finding into one of three categories:

- **positive_evidence** — the code or document actually implements or contains the DPDP concept matched by the regex (e.g., a consent withdrawal handler, a data erasure endpoint).
- **reference_only** — the code mentions the concept but does not implement it (e.g., a TODO comment about consent, a variable name, a documentation reference).
- **negative_evidence** — the code explicitly states the concept is NOT present or NOT implemented (e.g., "consent not yet implemented").

Each classification includes a reasoning string and a confidence score (0.0–1.0).

## 4. What AI Does NOT Do

- Does **not** determine compliance or non-compliance.
- Does **not** produce PASS/FAIL verdicts.
- Does **not** assign scores or risk ratings.
- Does **not** identify violations or regulatory breaches.
- Does **not** modify the evidence findings submitted to the backend.
- Does **not** replace the deterministic scanner — it only enriches its output.

## 5. Data Boundary

What is sent to the AI provider:

- Only the `location`, `findingType`, and `excerpt` fields of each finding.
- 3 lines of surrounding source context before and after each match (configurable via `contextLines` option).
- File paths are relative to the scan root.

What is **never** sent:

- Full source files.
- CONFIG files (`.env`, `.env.example`, etc.) — these are skipped entirely to avoid leaking secrets.
- Credentials, tokens, or API keys.
- Scan metadata, assessment IDs, or backend URLs.

The feature is **opt-in** (`--ai` flag). Without it, no AI provider is contacted.

## 6. Implementation

### Files

| File | Purpose |
|------|---------|
| `src/ai/classify.ts` | Core classification logic: context extraction, prompt construction, response parsing, OpenAI-compatible provider, fabricated-location rejection |
| `src/ai/classify.test.ts` | 11 test suites covering parsing, context extraction, batching, CONFIG skipping, malformed responses, provider failures, and fabricated-location rejection |
| `src/cli/commands/scan.ts` | CLI integration: `--ai` flag, calls `classifyFindings()` post-scan, stores result in `ScanState.extra.aiContext` |

### Groq-Compatible Provider

`createOpenAiCompatibleProvider()` uses native `fetch` (no SDK dependency) and works with any OpenAI-compatible API endpoint. Configuration via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GROQ_API_KEY` | Yes | — | Groq API key. If missing, AI is silently skipped. |
| `GROQ_BASE_URL` | No | `https://api.groq.com/openai/v1` | Base URL for Groq API |
| `GROQ_MODEL` | No | `allam-2-7b` | Model to use for classification |

### Key Design Decisions

- **Fetch-based provider**: No Groq/OpenAI npm dependency. Uses native `fetch` with `AbortController` timeout (30s default).
- **Batched by file**: Findings from the same source file are grouped into a single prompt to minimize API calls.
- **Input validation**: Only classifications whose `location|findingType` key matches an input finding are accepted. Fabricated locations are silently dropped.
- **Graceful degradation**: Provider failures for individual files do not abort other files. Malformed responses return empty classifications.

## 7. Storage

AI classification results are stored in `ScanState.extra.aiContext`:

```typescript
type ClassificationResult = {
  classifiedAt: string;       // ISO timestamp
  provider: string;           // e.g. "openai"
  model: string;              // e.g. "gpt-4o-mini"
  classifications: FindingClassification[];
};

type FindingClassification = {
  location: string;           // "relative/path:line"
  findingType: string;        // matches Finding.findingType
  classification: "positive_evidence" | "reference_only" | "negative_evidence";
  reasoning: string;
  confidence: number;         // 0.0–1.0
};
```

**No storage or evidence schema changes.** The `extra` field on `ScanState` already existed for capability-specific state (used by VAPT). AI classification uses the same extension point.

## 8. Failure Behavior

AI failures **never** prevent normal evidence submission:

- Missing `GROQ_API_KEY` → prints a warning, scan proceeds normally.
- Provider network error → caught per-file, other files continue.
- Malformed AI response → parsed as empty classifications, scan proceeds.
- All classifications rejected (fabricated locations) → `aiContext` not stored, scan proceeds.
- Timeout (30s default) → treated as provider failure, scan proceeds.

In all cases, the deterministic scanner output and backend submission are unaffected.

## 9. Testing

### Automated Tests

- **172/172 tests passing** (including Groq provider configuration and request construction tests)
- TypeScript typecheck: clean
- Build: clean (`npm run build`)

### CLI Smoke Tests

| Test | Result |
|------|--------|
| `dpdp scan` without `--ai` | ✅ Behaves exactly as before |
| `dpdp scan --ai` with valid Groq provider | ✅ AI classifications stored, backend payload unchanged |
| `dpdp scan --ai` with malformed JSON response | ✅ Scan completes, evidence submitted normally |
| `dpdp scan --ai` with fabricated location in response | ✅ Fabricated classification rejected, scan completes |
| Backend payload integrity | ✅ `POST /api/v1/assessments/:id/cli/scans` unchanged |

### Groq Integration Validation

- Provider: Groq (`allam-2-7b`)
- Real API request successfully verified
- API authentication verified
- Real CLI scan verified (`dpdp scan --ai`)
- AI classifications stored in `ScanState.extra.aiContext`
- Original evidence unchanged
- Backend payload unchanged
- CONFIG evidence excluded
- Malformed AI response tested
- Provider failure tested
- Fabricated classifications rejected
- 172/172 automated tests passing
- Typecheck passing
- Build passing

## 10. Known Limitations

- **Advisory only**: AI classifications are informational enrichment, not compliance determinations.
- **External provider privacy**: Source code context is sent to an external API. Users should be aware of their provider's data retention and privacy policies.
- **No retry mechanism**: A failed API call is not retried. The finding simply gets no AI classification for that run.
- **Local only**: AI classifications are stored locally in `ScanState.extra.aiContext`. They are not submitted to the backend and are not visible in the DPDPOS platform UI.
- **Duplicate classifications across batches**: The deduplication set is per-file-batch, not global. If the same finding key appears in results for different source files, it may appear twice in `allClassifications`. This is currently benign (no downstream consumer depends on uniqueness) but worth noting.
- **Incomplete AI classification**: The AI model may occasionally return fewer classifications than the number of input findings. This is acceptable for the MVP because AI is advisory enrichment and deterministic evidence collection remains authoritative. All findings are still submitted to the backend regardless of AI classification coverage.

## 11. Future Considerations

Possible areas for future investigation (not proposed for immediate implementation):

- **Backend integration**: Submitting `aiContext` alongside evidence for platform-side display.
- **Retry with backoff**: Transient failure recovery for the AI provider call.
- **Local model support**: Running classification via a local model to avoid sending source code externally.
- **Prompt refinement**: Iterating on the classification prompt based on real-world accuracy feedback.
- **Batch size tuning**: Adjusting the per-file batching strategy for large codebases.
- **Classification confidence thresholds**: Allowing users to filter or highlight low-confidence classifications.
