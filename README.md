# dpdp-cli

Read-only DPDP compliance scanner for the DPDPOS Compliance Management Platform.

It **collects** evidence from code/config/docs, **packages** structured findings, and **ships** them to the backend. It never mutates customer source files.

## Commands

```bash
npm install
npx tsx src/index.ts init
npx tsx src/index.ts login --token <token> --api http://127.0.0.1:3000
npx tsx src/index.ts configure --assessment <uuid>
npx tsx src/index.ts scan ./repo
npx tsx src/index.ts evidence
npx tsx src/index.ts submit
npx tsx src/index.ts status
npx tsx src/index.ts rescan ./repo
```

Create the CLI token from the platform:

`POST /api/v1/assessments/:id/cli/tokens` (user JWT).
