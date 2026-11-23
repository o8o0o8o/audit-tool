# Audit platform (web)

Next.js app: the public scan form, the internal app behind a login, the MCP server and the API, over Postgres.

- Production: `https://audit-tool-focusreactive.vercel.app` (Vercel, Neon, a private Vercel Blob store, workers on GitHub Actions).
- Design: [`docs/platform-api.md`](../docs/platform-api.md).
- Local build and the production settings: [`docs/platform-api-build.md`](../docs/platform-api-build.md) (§10 for production).
- How the first deployment was set up, and how to check it: [`docs/platform-deploy-guide.md`](../docs/platform-deploy-guide.md).

## Using the MCP server

The server is at `<app address>/api/mcp` (Streamable HTTP, stateless). A client sends an API key as `Authorization: Bearer <key>`.

**The short way, for a person with a login:** open **Set up MCP** in the internal menu (`/internal/mcp`) and press the button. The app makes your own key and shows a prompt that holds it; paste the prompt into your AI assistant, and the assistant adds the server and checks it. Audits started through that key count as yours on the usage page. You have one such key at a time: a new prompt switches the earlier key off, and the key stops working if your login is disabled.

**By hand, or for a service:**

1. **Get a key.** An admin logs in at `/internal`, opens **API keys**, enters a name, ticks the scopes and creates the key. It is shown once; only its hash is stored. Locally the same is done with `yarn --cwd web key:create --name=<name> --scopes=<a,b>`.
2. **Connect a client.** Claude Code:

   ```bash
   claude mcp add --transport http audit https://audit-tool-focusreactive.vercel.app/api/mcp \
     --header "Authorization: Bearer <key>"
   ```

   Any other MCP client that supports an HTTP server with a custom header uses the same address and header.

3. **Use it**, for example: "run a quick scan of example.com, wait for it and show the lead summary".

| Scope | Allows |
|---|---|
| `audits:read` | reading audits, findings, lead summaries, reports |
| `audits:start:quick` | starting quick scans and single-page audits |
| `audits:start:full` | starting full audits (and the LLM, verify and content-research options) |
| `audits:cancel` | cancelling audits the key started |
| `audits:pdf` | requesting PDFs |
| `audits:publish` | the lead pipeline's import routes |
| `prospects:read`, `prospects:write` | prospect rows; prospect fields in summaries |

Tools: `start_audit`, `get_audit`, `wait_for_audit`, `list_audits`, `continue_audit`, `cancel_audit`, `get_lead_summary`, `list_lead_summaries`, `get_site`, `list_findings`, `get_tech_stack`, `get_recommendations`, `get_site_checks`, `list_check_types`, `get_prospect`, `list_prospects`, `get_report_url`, `request_pdf`.

Waiting for an audit: `wait_for_audit` holds one call for up to 280 seconds and returns the moment the audit ends, so a quick scan or single page is one call. Its answer is short on purpose (status, pages, estimated time left, what to do next), and for a long full audit it tells the assistant to report the time left instead of calling in a loop. A client that cuts tool calls at 60 seconds needs a smaller `timeout_seconds`.

Answers are kept small, because an assistant pays for every character it reads (`lib/mcp/thrift.ts`): compact JSON with one copy of the answer, null and empty fields left out of rows, short pages by default (20 audits, 25 findings, lead summaries, check types and prospects, 10 recommendations), and the long parts only on request (`detail="full"`, `with_fix`, `with_record`, a larger `limit`). No tool sends an output schema with the tool list. The server still checks `get_lead_summary` against its schema (`lib/model/lead-summary.ts`).

Limits:

- A key makes 60 calls an hour unless another number is set when it is created.
- A key made on the **API keys** page is not tied to a person: its audits count under the key's name on the usage page. A key from **Set up MCP** is its owner's, allows 300 calls an hour, and has every scope except `prospects:write` and `audits:publish`.
- A key that has `audits:read` reads every audit; it cancels only the audits it started.
- Clients that sign in with OAuth (claude.ai connectors, for example) cannot connect: the server accepts API keys only.
- Revoking a key on the **API keys** page takes effect at once.

## Running it locally

Needs Docker, Node 22 or newer and yarn.

```bash
yarn && yarn --cwd web                    # install both projects
npx playwright install chromium           # the browser the audits use
docker compose up -d db                   # Postgres 17 on port 5433 (creates audit and audit_test)
cp web/.env.local.example web/.env.local  # then fill the secrets (see the file)
yarn --cwd web hash-password              # → INTERNAL_PASSWORD_HASH
yarn --cwd web db:migrate
yarn --cwd web dev                        # http://localhost:3000
yarn --cwd web crons                      # second terminal: reaper, dispatch, PDF jobs, loader, re-score, webhooks, retention
yarn --cwd web key:create --name=local --scopes=audits:read,audits:start:quick,prospects:read
claude mcp add --transport http audit-local http://localhost:3000/api/mcp --header "Authorization: Bearer <key>"
```

- **Login.** The shared password (`INTERNAL_PASSWORD_HASH`) works while no admin exists. `yarn --cwd web admin:create --email=<email> [--name=<name>]` adds a person (it asks for a password); from then on everyone logs in with their own email and password. The same command sets a new password; `--disable` stops a person from logging in.
- **Workers.** Each dispatched audit runs `scripts/platform-worker.ts` as a child process in `.platform/work/<audit>-<attempt>/`; its output is in `.platform/logs/<audit>-<attempt>.log`. Files are stored under `.platform/files/`.
- **The public form.** Add `PUBLIC_SCANS=on` to `web/.env.local`; without it `/` redirects to `/internal`. With Cloudflare's test keys from `.env.local.example` the form also shows the bot check.
- **Tests.** `yarn test` at the repo root; the platform tests (`tests/platform/`) need the Docker database and are skipped without `DATABASE_URL_TEST`.
- **Reset everything:** `docker compose down -v && rm -rf .platform`.

Seed data: `yarn --cwd web seed:prospects` (`docs/gtm/companies.csv`, or `--sample` for five made-up rows). Runs made before the platform (`audit-results/`, `lead-results/`) are not imported: only audits run through the platform, or published by the lead pipeline, are in the database.

The lead pipeline uses the API instead of the CSV when the repo-root `.env` has `AUDIT_API_URL=http://localhost:3000` and `AUDIT_API_KEY=<key with audits:publish, prospects:read, prospects:write>`.

## Pages

Public (on when `PUBLIC_SCANS=on` or both Turnstile keys are set):

- `/` — the scan form: an address and Quick scan or Single page, nothing else. Limits per address, per site and per day apply.
- `/scan/<audit id>` — the result of one public scan: progress, then the report. Exists only for audits the public site started; not indexed.

Internal (login required):

- `/internal/login` — email and password (5 failures per IP per 15 min, then a lockout; signed httpOnly cookie, 12 h).
- `/internal` — dispatch form (full audit, quick scan, single page; presets; perf, visual, PDF). Live progress comes from the `audits` row.
- `/internal/runs` — every audit, all sources and all users, newest first; filter by domain and status.
- `/internal/audits/<id>` — status, phase, progress, scores, scan quality, report links, "Cancel audit", "Continue crawl", "Generate PDF".
- `/internal/audits/<id>/view` — the HTML report with the site header and footer around it, served sandboxed. Where the audit tool is installed next to the app (locally) it is rendered on view from the database with the current report and scoring code; in production it is the HTML the run stored.
- `/internal/keys` — create (shown once) and revoke API keys.
- `/internal/mcp` — "Set up MCP": one click makes the logged-in person's own API key and a prompt to paste into an AI assistant. The form, the runs list and the audit page each carry a one-line hint that links here.
- `/internal/usage` — audits, websites, pages and audit types per user (admin, API key, or source) for a period.

Reports and files:

- `/r/<token>/report.html`, `/r/<token>/a/<artifact>` — the only way to open a report or file: the token names one audit and expires after 1 h; sandboxed, `Referrer-Policy: no-referrer`.

## Routes

- `POST /api/mcp` — the MCP server (see above).
- `POST /api/public/scans`, `GET /api/public/scans/<id>` — the public form's start and the result page's polling.
- `/api/v1/guard`, `/api/v1/prospects`, `/api/v1/prospects/<id>`, `/api/v1/audits/import`, `/api/v1/audits/<id>/complete`, `/api/v1/audits/<id>/gate-runs` — the lead pipeline.
- `/api/worker/*` — register, heartbeat, status, progress, guard, upload-token, upload-url (production: an upload address per file), upload (local file store), snapshot, continue, file (PDF jobs).
- `GET /api/cron/tick`, `GET /api/cron/retention` — the two timers, called by `.github/workflows/platform-cron.yml` with `Authorization: Bearer $CRON_SECRET`.
- `/api/internal/*` — what the internal pages call.
- `/api/health` — `{ ok, modelVersion }`.
- `/api/dev/webhook-log` — local mode only: logs webhook deliveries to `.platform/logs/webhooks.log` (use `http://localhost:3000/api/dev/webhook-log` as a key's webhook URL).

## Database

- `db/schema.ts` (Drizzle) and `db/migrations/` (generated with `yarn db:generate --name=<name>`, committed; a migration that only holds SQL, such as a view, with `npx drizzle-kit generate --custom --name=<name>`).
- Every lead summary in one query: `select * from lead_summary_latest` (the newest full and quick audit of each site; `lead_summary` has every audit). The views are the default signal set; `list_lead_summaries` reads them.
- Production: `DATABASE_URL='<unpooled Neon address>' yarn --cwd web db:migrate` applies new migrations; do it before deploying code that needs them.

## Code

- `lib/core/` — every operation, each taking a `Principal` and checking scopes itself.
- `lib/platform/` — the three interfaces (`FileStore`, `Dispatcher`, `WorkerIdentity`), with `local/` (disk, child process, signed token) and `production/` (private Blob, GitHub workflow dispatch, GitHub OIDC) behind `PLATFORM_MODE`.
- `lib/mcp/tools.ts` — tool definitions.
- `scripts/` — `create-key`, `create-admin`, `hash-password`, `db-migrate`, `local-crons`, `seed-prospects`, `reload-audits`, `check-blob-store` (tries the production file store against the real Blob store).
- `web/` imports from the root `lib/` only through `lib/model/` (alias `@model/*`) and one file of `lib/platform-worker/`; scripts under `web/scripts/` may import more.

## Look and feel

The UI reuses focusreactive.com: header, footer, buttons, form fields, chips, fonts, logos and favicon. `yarn sync-fr-ui` compiles the site's SCSS partials (`src/sassNew` in the `focusreactive.com-front` repo) into `app/fr-ui.css` and copies its assets to `public/assets/` and `app/favicon.ico`. It reads from `origin/main` via `git archive`, so fetch that repo first; `--repo=<path>` and `--ref=<ref>` override the defaults (`../../focusreactive.com-front`, `origin/main`). Don't edit `fr-ui.css` by hand.

## Left from the old flow

`scripts/upload-results.mjs`, `scripts/vercel-blob-env.sh`, `lib/blob.ts` and `.github/workflows/audit.yml` belong to the flow before the platform (a workflow that uploaded to a public Blob store). The platform does not use them. The workflow can still be run by hand from GitHub; nothing in the app shows its results.
