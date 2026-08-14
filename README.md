# dpdp-cli

Read-only DPDP compliance scanner for the DPDPOS Compliance Management Platform.

It **collects** evidence from code/config/docs, **packages** structured findings, and **ships** them to the backend. It never mutates customer source files.

## Directory identity (Windows AD / Entra / Microsoft 365)

Enterprise SSO does **not** change how the CLI authenticates for scans.

1. Operators sign into the **frontend** with Microsoft Entra, Windows AD (LDAP), or local password.
2. They mint a `dpdp_…` assessment CLI token in the Assessments → CLI tab (requires `assessment:cli_token`).
3. The CLI continues to use that opaque token for `scan` / `submit` / `status`.

This keeps machine evidence tokens separate from human SSO sessions (better audit, shorter blast radius if a laptop token leaks).

Optional: `DPDP_USER_TOKEN` (user JWT after SSO) may still be used only for the optional `report` command.

## Where to get the CLI token

Use the **product frontend** (not PowerShell, not `/demo`):

1. Open `http://localhost:3001/login` and sign in (password, Microsoft, or Windows AD)
2. Go to **Assessments** → open (or create) an assessment
3. Complete **Documents** + **Questionnaire** tabs
4. Open the **CLI** tab → **Generate CLI token**
5. Copy the one-time `dpdp_…` token and the command block

Create a **new assessment version** in the Overview tab before a historical rescan. Then run `scan` + `submit` again on that version.

Evaluation and reports live in the frontend **Results** tab (`Evaluate controls`). The CLI `report` command is optional and needs a separate user JWT (`DPDP_USER_TOKEN`).

## Commands

```bash
npm install
npx tsx src/index.ts init
npx tsx src/index.ts login --token <dpdp_...> --api http://127.0.0.1:3000
npx tsx src/index.ts configure --assessment <uuid>
npx tsx src/index.ts scan ./fixtures/sample-app
npx tsx src/index.ts evidence
npx tsx src/index.ts submit
npx tsx src/index.ts status
```

## Notes

- `scan` saves findings locally first, then creates a remote scan job.
- Token values from the platform always start with `dpdp_`.
- `rescan` = scan + submit on the **current** assessment version (version bump is done in the frontend).
