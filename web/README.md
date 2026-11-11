# Audit dispatcher (web)

Next.js app that dispatches SEO audits to GitHub Actions and shows their reports from Vercel Blob. Setup is described in the root README under "Web dispatcher (Vercel)".

## Pages

- `/` — dispatch form (URL, perf, llm, verify, content research, concurrency, page limit, evidence cap), with an estimated audit duration next to "Start audit" that updates as options change (assumes ≈100 pages when no limit is set).
- `/runs` — all runs, newest first (reads `audits/*/status.json` from Blob).
- `/runs/<runId>` — status, report links and the GitHub Actions run link; polls while the run is in progress.

## API

- `POST /api/dispatch` — validates the body (`lib/audit-options.ts`) and triggers the `audit.yml` workflow; returns `{ runId }`. Requests must send `DISPATCH_SECRET` in the `x-dispatch-key` header (the form's "Access key" field) or get 401; if `DISPATCH_SECRET` is unset the endpoint refuses every dispatch with 500.
- `GET /api/runs/<runId>` — returns that run's `status.json`.

## Local development

```bash
cp .env.example .env.local   # fill in GITHUB_TOKEN and BLOB_READ_WRITE_TOKEN and DISPATCH_SECRET
yarn install
yarn dev
```

`scripts/upload-results.mjs` is run by the workflow to upload `audit-results/<domain>/<ts>/` and write `status.json`.
