# dpdp-cli

Read-only DPDP compliance scanner for the DPDPOS Compliance Management Platform.

It **collects** evidence from code/config/docs, **packages** structured findings, and **ships** them to the backend. It never mutates customer source files.

## Install from npm

Requires **Node.js 20+**.

```bash
npm install -g dpdp-cli
```

Or run without a global install:

```bash
npx -p dpdp-cli dpdp <command>
```

The published binary name is `dpdp`.

### Publishing this package (maintainers)

1. Set `"private": false` in `package.json` when ready.
2. `npm run build` then `npm test`.
3. `npm login` → `npm publish --access public`.

Point end users at your **deployed** API URL (`https://…`), not `localhost`.  
Full stack deploy (API, worker, Vercel, Neon, Upstash, R2, Entra, npm):  
see **`dpdpos_backend/docs/14_deployment.md`**.

## Directory identity (Windows AD / Entra / Microsoft 365)

Enterprise SSO does **not** change how the CLI authenticates for scans.

1. Operators sign into the **frontend** with Microsoft Entra, Windows AD (LDAP), or local password.
2. They mint a `dpdp_…` assessment CLI token in the Assessments → CLI tab (requires `assessment:cli_token`).
3. The CLI continues to use that opaque token for `scan` / `submit` / `status`.

This keeps machine evidence tokens separate from human SSO sessions (better audit, shorter blast radius if a laptop token leaks).

Optional: `DPDP_USER_TOKEN` (user JWT after SSO) may still be used only for the optional `report` command.

## Where to get the CLI token

Use the **product frontend** (not PowerShell, not `/demo`):

1. Open the DPDPOS console and sign in (password, Microsoft, or Windows AD)
2. Go to **Assessments** → open (or create) an assessment
3. Complete **Documents** + **Questionnaire** tabs
4. Open the **CLI** tab → **Generate CLI token**
5. Copy the one-time `dpdp_…` token and the command block (includes `npm install -g dpdp-cli` and the production `--api` URL)

Create a **new assessment version** in the Overview tab before a historical rescan. Then run `scan` + `submit` again on that version.

Evaluation and reports live in the frontend **Results** tab (`Evaluate controls`). The CLI `report` command is optional and needs a separate user JWT (`DPDP_USER_TOKEN`).

## Commands

```bash
npm install -g dpdp-cli

dpdp init
dpdp login --token <dpdp_...> --api https://your-api.example.com
dpdp configure --assessment <uuid>
dpdp scan .
dpdp evidence
dpdp submit
dpdp status
```

### Local development (from this repo)

```bash
npm install
npx tsx src/index.ts login --token <dpdp_...> --api http://127.0.0.1:3000
npx tsx src/index.ts configure --assessment <uuid>
npx tsx src/index.ts scan ./fixtures/sample-app
npx tsx src/index.ts evidence
npx tsx src/index.ts submit
npx tsx src/index.ts status
```

```bash
# VAPT capability (passive, authorized scope only; backend not connected yet)
npx tsx src/index.ts vapt scope --target https://app.example.com --target-type URL --authorized-by you@corp --purpose "release assessment"
npx tsx src/index.ts vapt scan
npx tsx src/index.ts vapt findings
```

## Notes

- `scan` saves findings locally first, then creates a remote scan job.
- Token values from the platform always start with `dpdp_`.
- `rescan` = scan + submit on the **current** assessment version (version bump is done in the frontend).
- `vapt` is a passive, non-destructive capability: it refuses to run without an
  explicitly authorized scope, never contacts excluded targets/ports, and
  stores findings locally under `~/.dpdp/`. Backend VAPT APIs do not exist
  yet, so `vapt submit`/`vapt status` report local state and show the exact
  payload that will be submitted once connected.

## Local storage

Local state lives under `~/.dpdp/` and is migrated automatically from the
legacy single-file `~/.dpdp/config.json` on first use (non-destructive):

```
~/.dpdp/
  schema.json                    storage schema version
  config/config.json             apiBaseUrl, assessmentId
  config/vapt/<assessmentId>.json  per-assessment VAPT scope (Phase 4)
  credentials/credentials.json   CLI token (mode 0600 on POSIX)
  state/current-scan.json        pointer to the current scan (DPDP only)
  state/scans/<scanId>.json      per-scan state (job id, status, timestamps; VAPT scans carry capability + extra)
  evidence/<scanId>.json         per-scan evidence (DPDP findings, or VAPT findings at schemaVersion 2)
```

Evidence is stored per scan, survives failed submissions, and can be
retrieved offline; the bearer token never appears outside
`credentials/credentials.json`.

## Development

```bash
npm install
npm run build   # typecheck + compile to dist/
npm test        # node:test via tsx (no extra test deps)
```

The CLI is organized as an evidence-collection platform: the scanner engine
(`src/core/scanner/`) orchestrates collectors → analyzers → evidence
normalization/dedup. The current regex scanner is one analyzer
(`src/analyzers/source/regex/`); future analyzers register into the engine via
`src/core/profiles/` without touching the engine or CLI entry point.

## Design documents

The data and execution contract for the future VAPT capability is defined in
[`docs/vapt/`](./docs/vapt/) (design only — nothing implemented).

## Related repos

| Repo | Purpose |
|---|---|
| `dpdpos_backend` | API + worker — see `docs/14_deployment.md` |
| `dpdpos` | Next.js console (Vercel) |

