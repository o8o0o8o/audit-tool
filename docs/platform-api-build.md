# Audit platform: local build guide

How to build steps 1–4 of [`platform-api.md`](platform-api.md) on one machine. The design doc says what the platform is and why; this guide says where the code goes, how to run it, and what proves each task done. Section numbers like "§4" point into the design doc.

Status: written 2026-11-21; steps 0–4 built locally the same day on branch `platform-api-local` (see "Built so far" at the end). The five acceptance checks of §7 pass.

Scope: the local build only (steps 1–4). Deployment, the public site (step 5) and page rows (step 6) get their own sections when the local build is done.

## 1. What you need

- Docker with Compose, Node 22 or newer, yarn. (Checked on the main dev machine: Docker 28, Compose 2.39, Node 24.)
- `yarn` at the repo root and `yarn --cwd web` done, `npx playwright install chromium`.
- No Vercel, Neon or GitHub access. No real API keys except, optionally, `CRUX_API_KEY` for field data in quick scans.

## 2. Running it

### Files to add

`docker-compose.yml` at the repo root:

```yaml
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_USER: audit
      POSTGRES_PASSWORD: audit
      POSTGRES_DB: audit
    ports: ['5433:5432']        # 5433, so a Postgres already on the machine is not in the way
    volumes: ['audit-db:/var/lib/postgresql/data']
volumes:
  audit-db:
```

`web/.env.local` (copy from a new `web/.env.local.example`):

| Variable | Local value | Used for |
|---|---|---|
| `PLATFORM_MODE` | `local` | picks the local `FileStore`, `Dispatcher`, `WorkerIdentity`. The app refuses to start with `local` when `VERCEL_ENV=production` |
| `DATABASE_URL` | `postgres://audit:audit@localhost:5433/audit` | app and migrations |
| `DATABASE_URL_TEST` | `postgres://audit:audit@localhost:5433/audit_test` | tests (§6 below) |
| `APP_URL` | `http://localhost:3000` | links, and where the worker calls back |
| `FILES_DIR` | `../.platform/files` | the local file store (add `.platform/` to `.gitignore`) |
| `INTERNAL_PASSWORD_HASH` | made by `yarn --cwd web hash-password` | internal login |
| `SESSION_SECRET` | any 32+ random characters | signs the internal cookie |
| `REPORT_TOKEN_SECRET` | any 32+ random characters | signs `/r/{token}` links |
| `LOCAL_WORKER_SECRET` | any 32+ random characters | signs the local worker's identity token |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Cloudflare's always-pass test keys (from their docs) | only needed from step 5 |
| `CRUX_API_KEY` | optional | field metrics in quick scans |

### Commands

```bash
docker compose up -d db                 # 1. database
yarn --cwd web db:migrate               # 2. create or update tables
yarn --cwd web dev                      # 3. the app, http://localhost:3000
yarn --cwd web crons                    # 4. dispatch, loader, reaper, webhooks, retention in a loop (second terminal)
yarn --cwd web key:create --name=local --scopes=audits:read,audits:start:quick,prospects:read   # 5. prints an API key once
```

There is no command to start a worker: in local mode the `Dispatcher` starts one as a child process for every dispatched audit, and its output goes to `.platform/logs/<audit id>-<attempt>.log`.

Connect an MCP client (Claude Code):

```bash
claude mcp add --transport http audit-local http://localhost:3000/api/mcp --header "Authorization: Bearer <key>"
```

Reset everything: `docker compose down -v && rm -rf .platform`.

## 3. Where the code goes

```
docker-compose.yml
lib/
  model/                     zod schemas of the AuditModel (site document, page record, lead summary). Zod only:
                             no fs, no Playwright, so web/ can import it. buildAuditModel lives next to it in
                             lib/model/build/ and may use anything
  platform-worker/           the worker's side: app client (register, heartbeat, status, progress, guard,
                             upload), snapshot + restore, secrets masking before upload
scripts/
  platform-worker.ts         one worker entry, used by the local Dispatcher now and by audit.yml later
  build-model.ts             <run dir> → model/ files, for trying the model on stored runs
web/
  db/
    schema.ts                Drizzle tables, from the SQL in §4 "Exact schema"
    migrations/              generated SQL, committed
    client.ts                one connection pool
  lib/
    platform/
      types.ts               the three interfaces (§4 below)
      index.ts               picks implementations by PLATFORM_MODE
      local/                 disk file store, child-process dispatcher, HMAC identity
      production/            Blob, GitHub dispatch, GitHub OIDC (written at deployment, not now)
    core/                    every operation, each taking a Principal:
      principal.ts  audits.ts  queue.ts  guard.ts  attempts.ts  reaper.ts  loader.ts
      prospects.ts  reports.ts  webhooks.ts  jobs.ts  lead-summary.ts  results.ts
    mcp/                     tool definitions: name, description, zod input, call into core
  app/
    api/mcp/route.ts
    api/worker/{register,heartbeat,status,progress,guard,upload-token}/route.ts
    api/v1/{guard,prospects,audits/import,audits/[id]/gate-runs}/route.ts
    api/internal/...         what the internal pages call
    r/[token]/[...path]/route.ts
    internal/...             login, dispatch form, runs list, run page, keys
  scripts/
    local-crons.ts  create-key.ts  hash-password.ts  import-run.ts  seed-prospects.ts
tests/platform/              database and run-path tests (§6 below)
```

Two rules for the layout:

- **`web/` imports from the root `lib/` only through `lib/model/`.** Today `web/` is its own app with its own lockfile and `outputFileTracingRoot` set to `web/`, and it imports nothing from the root. For the local build, add a path alias `@model/*` → `../lib/model/*` in `web/tsconfig.json`, set `experimental.externalDir: true` in `next.config.mjs`, and add `zod` to both `package.json` files at the same version. Whether Vercel's build accepts this, or the repo needs yarn workspaces, is a deployment question (§8 below); nothing else may depend on the answer.
- **One worker entry.** `scripts/platform-worker.ts` does what the shell in `audit.yml` does today (build the CLI arguments, run `start.ts`, upload) plus registration, heartbeat, snapshots and the model build. The local `Dispatcher` and, later, the workflow both run this file, so the code path proven locally is the one production uses.

## 4. The three interfaces

`web/lib/platform/types.ts`:

```ts
/** Private file storage. Keys are paths like `audits/<id>/<attempt>/model/site.json.gz`. */
export interface FileStore {
  put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, opts?: { contentType?: string }): Promise<{ bytes: number; sha256: string }>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; bytes: number; contentType?: string } | null>;
  list(prefix: string): AsyncIterable<{ key: string; bytes: number }>;
  delete(keys: string[]): Promise<void>;
  /** What a worker needs to upload under `prefix` and nowhere else. Local: a URL on the app plus a signed token. */
  issueUpload(prefix: string, ttlSeconds: number): Promise<{ url: string; headers: Record<string, string> }>;
}

export type WorkerKind = 'audit' | 'render-pdf';

export interface DispatchRequest {
  kind: WorkerKind;
  /** audits.id or jobs.id */
  id: string;
  attempt: number;
  nonce: string;
  /** Everything the worker needs to build its command line; never a secret. */
  inputs: Record<string, string>;
  resumeFromAttempt?: number;
}

/** Starts and controls workers. Throws DispatchUnavailable when the backend refuses; the row then stays queued. */
export interface Dispatcher {
  dispatch(req: DispatchRequest): Promise<void>;
  /** For the reaper: is a run for this attempt waiting, running or gone? */
  state(id: string, attempt: number): Promise<'waiting' | 'running' | 'gone'>;
  cancel(id: string, attempt: number): Promise<void>;
}

export interface WorkerClaims {
  /** Identifies the run on the backend: GitHub's run_id, or the local child's id. */
  runId: string;
  runAttempt: number;
}

/** Checks the token a worker sends to `register`. Returns null when it is not valid. */
export interface WorkerIdentity {
  verify(token: string): Promise<WorkerClaims | null>;
}
```

Local implementations:

- **`FileStore`**: files under `FILES_DIR`, the key as the relative path; refuse any key that leaves the folder. `issueUpload` returns `POST {APP_URL}/api/worker/upload` with a token signed by `LOCAL_WORKER_SECRET` that names the prefix.
- **`Dispatcher`**: `spawn('npx', ['tsx', 'scripts/platform-worker.ts', …])` at the repo root, in its own process group, with a results folder of its own (`.platform/work/<id>-<attempt>/`) so two workers never share `audit-results/`. `state` reads a pid file; `cancel` kills the group.
- **`WorkerIdentity`**: a short-lived token signed with `LOCAL_WORKER_SECRET`, carrying the child's id.

## 5. Tasks

Each task is meant to be a day or less; the day counts are rough guesses, about 40 working days in total for one person. "Done when" names the check; tests live in `tests/platform/` unless noted.

### Step 0: foundation (about 3 days)

| # | Task | Done when |
|---|---|---|
| 0.1 | `docker-compose.yml`, `.env.local.example`, `.gitignore` entries, `db:migrate` / `crons` / `key:create` / `hash-password` scripts in `web/package.json`; Drizzle, `pg`, zod added | `docker compose up -d db && yarn --cwd web db:migrate` runs on an empty machine |
| 0.2 | Test harness (§6 below) | a sample test creates a schema, runs the migrations, inserts a row, drops the schema |
| 0.3 | `web/lib/platform/types.ts`, the local `FileStore`, and the `PLATFORM_MODE` switch with the production refusal | tests: put / get / list / delete; a key with `..` is refused; starting with `local` and `VERCEL_ENV=production` throws |
| 0.4 | `lib/model/` import path from `web/` (alias, `externalDir`, zod in both packages) | `yarn --cwd web build` passes with one schema imported from `lib/model/` |

### Step 1: runs through the platform (about 12 days)

| # | Task | Done when |
|---|---|---|
| 1.1 | Tables `sites`, `site_aliases`, `audits`, `audit_attempts`, `artifacts`, `rate_events`, `action_log`, `api_clients` as Drizzle schema + first migration | the migration matches the SQL in §4; the partial unique index on active audits rejects a second row in a test |
| 1.2 | `Principal` (internal session, API client, report token) and the scope check helper; internal login route (password hash, per-IP limit of 5 per 15 min, signed cookie) | tests: a core call without a principal throws; the sixth wrong password is refused; a tampered cookie is refused |
| 1.3 | Site resolution: normalise a URL, registrable domain from the Public Suffix List (private section included), find or create `sites`, alias lookup | tests with `www.`, a `github.io` host, an IDN host, an alias |
| 1.4 | `core/audits.startAudit` (creates the row as `queued`, UUID id, `profile`, `profile_hash`, `comparable_key`), `getAudit`, `listAudits`, `cancelAudit` | tests: two simultaneous starts for the same client, site and profile give one audit |
| 1.5 | `core/queue.dispatchNext` with caps per source; the local `Dispatcher`; `local-crons.ts` with advisory locks | a queued audit becomes `dispatched` and a child process starts; a second cron loop running at the same time dispatches nothing twice |
| 1.6 | Worker routes `register`, `heartbeat`, `status`, `progress`, `upload-token` and `upload`; local `WorkerIdentity`; session token per attempt | tests: wrong nonce refused; second register for the same attempt refused; a call with an older attempt's session gets 409 |
| 1.7 | `scripts/platform-worker.ts` + `lib/platform-worker/`: register, heartbeat loop, build CLI arguments (replacing `toCliArgs` duplication with the workflow), run `start.ts`, forward progress, upload the run folder's files under `audits/{id}/{attempt}/`, report the final status | a quick scan of a local fixture site started from a test ends `succeeded` with a `report_html` artifact row |
| 1.8 | Snapshots: content-addressed upload after `saveProgress`, restore before `--proceed` (design §8.6) | test: kill the worker mid-crawl, restore in a fresh folder, the run finishes and the page count is complete |
| 1.9 | Reaper: the three rules of §3, at most 2 redispatches | tests with a fake clock: never registered → redispatch; heartbeat stopped → `stalled` then resumed; third failure → `failed` |
| 1.10 | `/r/{token}/report.html` and `/r/{token}/a/{artifact}`: signed token, sandbox header, `Referrer-Policy: no-referrer` | tests: expired or altered token refused; both headers present; a path outside the audit refused |
| 1.11 | Internal pages on the new core: the dispatch form, runs list and run page read `audits`; live progress reads the row; `/runs` and `/view` move under `/internal`; `DISPATCH_SECRET` removed | by hand: log in, start a quick scan, watch progress, open the report with its screenshots |
| 1.12 | `--pdf` in the audit tool (design §8.9): Phase 2, 3, 4 and the teaser print a PDF only with the flag or `pdf: true` in `.seoauditrc`; `scripts/render-pdf.ts`; README, `CLAUDE.md`, `completions.sh` | existing tests pass; a run without `--pdf` writes Markdown and HTML and no PDF. Wait for the "Teaser PDF" decision (§12) before touching the teaser stage |

### Step 2: the API (about 9 days)

| # | Task | Done when |
|---|---|---|
| 2.1 | Tables `prospects`, `suppressed_domains`; `web/scripts/seed-prospects.ts` (imports `docs/gtm/companies.csv`, or `--sample` for five made-up rows) | row counts match the CSV; `do_not_contact` rows carry the flag |
| 2.2 | Scan guard (`core/guard`) called from `startAudit`, from dispatch, and by the worker route `guard`; the worker asks it on a cross-domain homepage redirect | tests: a `do_not_contact` domain is refused by `www.` and apex forms; an audit guarded while queued is not dispatched; a redirect to a guarded domain ends `cancelled` with nothing stored |
| 2.3 | API keys: `create-key.ts`, hash at rest, bearer auth, `rate_limit_per_hour` through `rate_events` | tests: revoked key refused; the limit returns `rate_limited` |
| 2.4 | MCP endpoint with `start_audit` (idempotency, own in-progress audit, reuse of a recent one that is not blocked), `get_audit`, `wait_for_audit`, `list_audits`, `cancel_audit` | an MCP client lists the tools and completes a quick scan; a test covers each `reused` value |
| 2.5 | `get_prospect`, `list_prospects`; REST `GET/POST /prospects`, `PATCH /prospects/{id}`, `GET /guard` | tests per route and scope |
| 2.6 | `get_report_url` | the returned link opens the report without a cookie and stops after its expiry |
| 2.7 | Webhooks: `webhook_deliveries`, signing with timestamp, retries, address check (resolve, refuse private ranges, no redirects) | tests against the local logging endpoint: one delivery on success; retry after a 500; a `localhost` address is refused when `PLATFORM_MODE` is not `local` |
| 2.8 | `jobs`, `request_pdf`, the `render-pdf` worker kind (restores report text and images, prints, uploads) | `request_pdf` on a finished audit produces a `report_pdf` artifact; a second request joins the first job |

### Step 3: the model (about 10 days)

Before 3.1, two pieces of design work that the design doc leaves open:

- **The schemas.** Write `lib/model/site.ts` and `lib/model/lead-summary.ts` as zod, field by field, from what the consumers in design §2 read today. Review them before any builder code.
- **The first explicit codes** (design §8.2): count finding titles across the stored runs in `audit-results/` and `lead-results/`, take the 50 most frequent plus the lead types and the security checks.

| # | Task | Done when |
|---|---|---|
| 3.1 | Zod schemas for the site document and the lead summary, with descriptions on every field | reviewed; `z.toJSONSchema` output reads well as documentation |
| 3.2 | Finding codes: explicit `code` on `Issue` for the first list, derived codes with `params` for the rest, `check_types` seed, aliases | test: derived codes are identical across two builds of every fixture run; no code contains a number or a URL |
| 3.3 | Scan quality: one function with the thresholds, blocked pages marked, their findings dropped | tests from fixtures: a clean run is `ok`; a run with a challenged homepage is `blocked` and has no scores |
| 3.4 | `buildAuditModel` for the site part: site profile, vendors and tracking IDs (`lib/model/vendor-kinds.ts`), scores, recommendations, findings without occurrences, site checks, field metrics, lead-scan info; writes `model/site.json.gz` and `raw-archive.tar.gz` | `npx tsx scripts/build-model.ts <run dir>` validates against the schema for every stored run, full, lead and single-page |
| 3.5 | Tables `audit_documents`, `load_progress`, `check_types`, `check_type_aliases`, `findings`, `scores`, `recommendations`, `site_checks`, `scan_quality`, `site_profiles`, `field_metrics` | migration applied |
| 3.6 | Loader: reads the attempt that reported `built`, loads in transactions with `load_progress`, refuses an unknown model major, sets `succeeded`; the worker now reports `built` | tests: a loader killed halfway resumes and the row counts are right; an unknown major leaves the audit `built` with `load_blocked` |
| 3.7 | Run profiles in the tool (design §8.1): the `public` profile skips the JS-secrets scan, the takeover check and the gate; `disclosures` table, a row opened or updated per hit in the `standard` profile | tests: a public-profile run has neither check row; a second scan of the same exposure updates the row |
| 3.8 | `web/scripts/import-run.ts <run dir>`: builds the model for a stored run and loads it as an audit with `legacy_run_id` | all stored runs import; abilio.com loads and its database size is written down |

### Step 4: lead results (about 7 days)

| # | Task | Done when |
|---|---|---|
| 4.1 | Fingerprint as a worker step after every audit; `technologies`, `tracking_ids` tables and model fields | a full audit and a quick scan both have stack rows; a failing fingerprint does not fail the audit |
| 4.2 | Gate as a worker step after standard-profile quick scans; `lead_gate_runs`, `lead_facts`, `depends_on` per fact type; `gate-suspended.json` read from the checkout | a quick scan of a fixture site with planted defects yields passed facts in the tables |
| 4.3 | Secrets masking before upload (design §8.14), in the worker and in the pipeline's publish | test: a stored script with a planted key is masked on disk and the recorded hash is the original's |
| 4.4 | `get_lead_summary` with its published output schema, including `scan_quality` rules, `outreach_blocked`, `gate_run_at`, permanent internal links | tests: blocked scan → null scores and only allowed facts; open disclosure → `outreach_blocked` |
| 4.5 | `get_site`, `list_findings`, `get_tech_stack`, `get_recommendations`, `get_site_checks`, `list_check_types` | a test per tool; each result names the audit it used |
| 4.6 | Pipeline on the API: a prospect store interface with an API-backed implementation used by `lead-pipeline.ts`, `stages.ts`, `fingerprint.ts`, `score.ts` and `audit-companies.ts`; guard calls before `fingerprint` and `scan` | the existing `tests/leads-*` pass against both implementations; no code path writes the CSV when the API store is configured |
| 4.7 | `POST /audits/import`, `POST /audits/{id}/gate-runs`; `lead-pipeline.ts publish`, also after `rerank` | a local pipeline scan appears in `get_lead_summary`; a `rerank` adds a gate run and nothing else changes |

## 6. Tests

- Runner: the repo's existing `tsx --test 'tests/**/*.test.ts'`. Platform tests go in `tests/platform/` and import from `web/` by relative path, as `tests/web-*.test.ts` already do.
- Database: tests need Docker's Postgres. Each test file creates a schema with a random name in `DATABASE_URL_TEST`, runs the migrations into it, and drops it at the end, so files can run in parallel and never see each other's rows. When `DATABASE_URL_TEST` is not set the platform tests are skipped with a message, so `yarn test` still works without Docker.
- Time: `core` functions that depend on time take a `now` argument, as `newRunId` does today, so the reaper and expiry tests need no waiting.
- Workers: most tests use a fake `Dispatcher` that records requests. Three tests start a real worker against a local fixture site (served from `tests/fixtures/`): one clean quick scan, one killed and resumed, one redirecting to a guarded domain. They are slow and carry a `slow` tag.
- No test reaches the internet.

## 7. Seed data and the acceptance run

Seed:

- Prospects: `yarn --cwd web tsx scripts/seed-prospects.ts --sample`, or the real CSV.
- Audits: `yarn --cwd web tsx scripts/import-run.ts <run dir>` for stored runs. Start with one lead scan, one single-page run, `focusreactive.com` (medium) and `abilio.com` (largest).

The local build is done when these five pass, in order (they are the five checks in design §10):

1. `docker compose down -v`, then the five commands of §2, on a clean checkout: no manual step.
2. All stored runs import. For abilio.com, record the size of `audit_documents`, of `findings` and the load time in design §4's "not settled" list.
3. From the internal page, start a quick scan of a real site; kill the worker process during the crawl; within 15 minutes the audit resumes and ends `succeeded`.
4. From an MCP client with a key holding `audits:read` + `audits:start:quick`: `start_audit`, `wait_for_audit`, `get_lead_summary`. The summary validates against its schema, and a second `start_audit` with `reuse_if_newer_than_hours` returns `reused = recent`.
5. `lead-pipeline.ts scan --only=<domain>` with the API store configured, then `gate`, then `rerank`: the prospect's stage changes through the API, the scan is in the database, and two gate runs are listed.

## 8. Left for deployment

Not needed for the local build, and not to be guessed at while building it:

- The production implementations of the three interfaces, and the four platform checks in design §12.
- Whether Vercel builds `web/` with imports from the root `lib/model/`, or the repo moves to yarn workspaces.
- The database driver: `pg` with a pool works locally; on Vercel it needs Neon's pooled address, to be confirmed with one pass on a Neon branch.
- Copying existing public Blob uploads to the private store and removing the public copies.
- `audit.yml` rewritten to run `scripts/platform-worker.ts` with `id-token: write`.

## Built so far (2026-11-21)

Steps 0–4 exist as described above, with these differences:

- **Migrations:** three files, `0000_step1_core`, `0001_step2_prospects_api`, `0002_step3_4_results`. `yarn db:generate --name=<name>` strips the `"public".` schema prefix drizzle-kit writes, so tests can run migrations into a schema of their own. `docker/init-db.sql` creates `audit_test` when the volume is new.
- **`prospects.extra`** (`jsonb`, not in the design's SQL) keeps the other `companies.csv` columns, so the pipeline's API store round-trips every column it reads and writes.
- **Imports end with `POST /api/v1/audits/{id}/complete`** (not in §6): `audits/import` creates the audit and returns an upload grant; `complete` records the uploaded artifacts and sets `built`.
- **Finding codes (3.2):** explicit codes are seeded in `lib/model/check-types.json` (`scripts/build-check-types.ts`: the 50 most frequent findings across the stored runs plus every security and email-DNS finding, 69 codes). Analyzers do not set `Issue.code` yet; codes come from titles in `lib/model/finding-codes.ts`.
- **Password hash** format is `scrypt:<salt>:<hash>`: Next's env loader expands `$` in `.env.local` values.
- **Worker:** `start.ts` and the worker load tsx by absolute path, so a work folder anywhere works. The audit writes `$AUDIT_CHECKPOINT_MARKER` after each completed checkpoint save; the worker snapshots on it (first marker at once, then at most every `PLATFORM_SNAPSHOT_INTERVAL_MS`, default 10 min). A homepage redirect is followed hop by hop (no full load), so a redirect to an unreachable guarded domain is still refused.
- **`--pdf`:** Phase 2, 3 and 4 print PDFs only with the flag; the teaser stage is unchanged (open decision §12).
- **Stored runs are not imported (decided 2026-11-21):** only audits run through the platform, or published by the lead pipeline (`audits/import`), are in the database. Task 3.8 and acceptance check 2 are dropped; `import-run.ts` was built, measured (below) and removed.
- **Reports render from the database (step 6, first part; decided 2026-11-21):** `pages` (one row per page, the full page record in `sections`) and `audit_run_data` (manifest, metadata, analysis, incoming links; not in the design's SQL) are loaded as row chunks (`model/run-data.json.gz`, `model/pages-NNNN.ndjson.gz`). On every view the app rebuilds the renderer's input from those rows (screenshots from the file store) and runs `scripts/render-report.ts` with the current code; History comes from earlier audits of the same site and `comparable_key`. Stored scores are kept current: `audits.scoring_version` (not in the design) records the scoring code they came from, and stale audits are re-scored from their rows (`scripts/score-run.ts`, on view and by the cron). `web/scripts/reload-audits.ts` backfills audits loaded before a model change.
- **Not built:** occurrences, link edges and the other step-6 tables; the public site (step 5); production implementations (§8). `audit.yml`, `upload-results.mjs` and `lib/blob.ts` are still the old flow.
- **Slow tests** (`tests/platform/worker.slow.test.ts`) run only with `PLATFORM_SLOW_TESTS=1`. The audit itself may still try PageSpeed/CrUX for the loopback fixture site; those calls fail harmlessly.

Measured: all 838 stored runs build a valid model (`npx tsx scripts/build-model.ts --all`, 27 s) and imported in 93 s before the import was dropped; the end-to-end quick scan of example.com takes ~36 s from `start_audit` to `succeeded`; a worker killed during the crawl was resumed by the reaper and finished 12.5 min after the kill.
