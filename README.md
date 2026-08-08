# dpdp-cli

Read-only DPDP compliance scanner for the DPDPOS Compliance Management Platform.

It **collects** evidence from code/config/docs, **packages** structured findings, and **ships** them to the backend. It never mutates customer source files.

## Where to get the CLI token

Use the **product frontend** (not PowerShell, not `/demo`):

1. Open `http://localhost:3001/login` and sign in
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
