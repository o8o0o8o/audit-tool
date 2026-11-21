# Audit platform (web)

Next.js app: the internal app behind a password, the MCP server and the API, over Postgres. Design: [`docs/platform-api.md`](../docs/platform-api.md). Local build guide: [`docs/platform-api-build.md`](../docs/platform-api-build.md). Production (Vercel, Neon, GitHub Actions workers) is not built yet: only `PLATFORM_MODE=local` exists.

## Running it locally

```bash
docker compose up -d db                 # Postgres 17 on port 5433 (creates audit and audit_test)
cp web/.env.local.example web/.env.local  # then fill the secrets (see the file)
yarn --cwd web hash-password            # → INTERNAL_PASSWORD_HASH
yarn --cwd web db:migrate
yarn --cwd web dev                      # http://localhost:3000 (redirects to /internal)
yarn --cwd web crons                    # second terminal: dispatch, loader, reaper, webhooks, PDF jobs, retention
yarn --cwd web key:create --name=local --scopes=audits:read,audits:start:quick,prospects:read
claude mcp add --transport http audit-local http://localhost:3000/api/mcp --header "Authorization: Bearer <key>"
```

Each dispatched audit runs `scripts/platform-worker.ts` as a child process in `.platform/work/<audit>-<attempt>/`; its output is in `.platform/logs/<audit>-<attempt>.log`. Files are stored under `.platform/files/`. Reset everything: `docker compose down -v && rm -rf .platform`.

Seed data: `yarn --cwd web seed:prospects` (`docs/gtm/companies.csv`, or `--sample` for five made-up rows); `yarn --cwd web import-run --all` imports every stored run in `audit-results/` and `lead-results/` (`--with-evidence` also copies screenshots and evidence).

The lead pipeline uses the API instead of the CSV when the repo-root `.env` has `AUDIT_API_URL=http://localhost:3000` and `AUDIT_API_KEY=<key with audits:publish, prospects:read, prospects:write>`.

## Pages

- `/internal/login` — password login (5 failures per IP per 15 min, then a lockout; signed httpOnly cookie, 12 h).
- `/internal` — dispatch form (full audit, quick scan, single page; presets; perf, visual, PDF). Live progress comes from the `audits` row; the finished report is embedded through a fresh `/r/{token}` link.
- `/internal/runs` — every audit, all sources, newest first; filter by domain and status.
- `/internal/audits/<id>` — status, phase, progress, scores, scan quality, report links, "Cancel audit", "Generate PDF".
- `/internal/keys` — create (shown once) and revoke API keys.
- `/r/<token>/report.html`, `/r/<token>/a/<artifact>` — the only way to open a report or file: the token names one audit and expires after 1 h; sandboxed, `Referrer-Policy: no-referrer`.

## Routes

- `POST /api/mcp` — MCP (Streamable HTTP, stateless), API key as bearer. Tools: `start_audit`, `get_audit`, `wait_for_audit`, `list_audits`, `cancel_audit`, `get_lead_summary`, `get_site`, `list_findings`, `get_tech_stack`, `get_recommendations`, `get_site_checks`, `list_check_types`, `get_prospect`, `list_prospects`, `get_report_url`, `request_pdf`.
- `/api/v1/guard`, `/api/v1/prospects`, `/api/v1/prospects/<id>`, `/api/v1/audits/import`, `/api/v1/audits/<id>/complete`, `/api/v1/audits/<id>/gate-runs` — the lead pipeline.
- `/api/worker/*` — register, heartbeat, status, progress, guard, upload-token, upload (local file store), snapshot, file (PDF jobs).
- `/api/internal/*` — what the internal pages call.
- `/api/dev/webhook-log` — local mode only: logs webhook deliveries to `.platform/logs/webhooks.log` (use `http://localhost:3000/api/dev/webhook-log` as a key's webhook URL).

## Code

- `db/schema.ts` (Drizzle) and `db/migrations/` (generated with `yarn db:generate --name=<name>`, committed).
- `lib/core/` — every operation, each taking a `Principal` and checking scopes itself.
- `lib/platform/` — the three interfaces (`FileStore`, `Dispatcher`, `WorkerIdentity`) and their local implementations.
- `lib/mcp/tools.ts` — tool definitions.
- `web/` imports from the root `lib/` only through `lib/model/` (alias `@model/*`); scripts under `web/scripts/` may import more.

## Look and feel

The UI reuses focusreactive.com: header, footer, buttons, form fields, chips, fonts, logos and favicon. `yarn sync-fr-ui` compiles the site's SCSS partials (`src/sassNew` in the `focusreactive.com-front` repo) into `app/fr-ui.css` and copies its assets to `public/assets/` and `app/favicon.ico`. It reads from `origin/main` via `git archive`, so fetch that repo first; `--repo=<path>` and `--ref=<ref>` override the defaults (`../../focusreactive.com-front`, `origin/main`). Don't edit `fr-ui.css` by hand.

## Not moved yet

`scripts/upload-results.mjs`, `lib/blob.ts` and `.github/workflows/audit.yml` still belong to the old Blob-based flow. They are replaced when the workflow runs `scripts/platform-worker.ts` (build guide §8).
