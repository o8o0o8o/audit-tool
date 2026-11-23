# Audit platform: first deployment

How to take branch `platform-api-local` from the repository to a deployed app that two or three people use. Written 2026-11-22. Settings are explained in [`platform-api-build.md`](platform-api-build.md) §10; the design is [`platform-api.md`](platform-api.md).

The database, the private Blob store (including the worker's upload request) and the Vercel build are checked (see below). The worker's path through GitHub (dispatch and its identity token) has not run yet: the first quick scan in step 6 is that test, and step 7 is the way back if it fails.

## What changes on merge

- The app at the Vercel address becomes the internal platform: `/` redirects to `/internal`, behind a login. The old public form is gone.
- Reports from before the platform are not shown in the new app. Their files stay in the old public Blob store.
- The old `audit.yml` workflow is untouched.
- The merge is a fast-forward: `main` has nothing the branch lacks.

## Done on 2026-11-23

Vercel project `audit-tool` in the FocusReactive team, production address `https://audit-tool-focusreactive.vercel.app`:

- **Neon database** `audit-platform` (region `fra1`) created through the Vercel integration and connected to Production: `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` are set. All migrations are applied (31 tables). Advisory locks were checked through the pooled address and work.
- **Vercel variables** (Production): `PLATFORM_MODE`, `APP_URL`, `WORKER_REPOSITORY`, `WORKER_REPOSITORY_ID`, `WORKER_OIDC_AUDIENCE`, `SESSION_SECRET`, `REPORT_TOKEN_SECRET`, `CRON_SECRET`. The live app from `main` reads none of them.
- **GitHub token:** none to create. The project already has `GITHUB_TOKEN`, which the old app dispatches workflows with; the platform uses it when `GITHUB_DISPATCH_TOKEN` is not set.
- **GitHub repository:** variables `PLATFORM_APP_URLS`, `PLATFORM_OIDC_AUDIENCE`, `PLATFORM_CRON_URL` and secret `PLATFORM_CRON_SECRET` (the same value as `CRON_SECRET`).
- **The Vercel build:** the branch's preview deployment built and is Ready.

- **Admins:** three people are created in the production database (step 2).

- **Merged and deployed** (2026-11-23), and Vercel's own login (Deployment Protection) now covers preview deployments only. It used to cover the production address too, which sends every request from outside, the GitHub worker's and the cron's included, to Vercel's login instead of the app. The app is therefore reachable from the internet and protected by its own login and API keys.
- **First audit in production:** a quick scan of example.com went from `start_audit` to `succeeded` in about 100 seconds: dispatch with the existing `GITHUB_TOKEN`, GitHub's identity token accepted, uploads to the private store, load into Neon. The cron workflow answered `tick: HTTP 200`. One fault showed and is fixed: Blob serves text compressed and reports its size as 0, and the report route sent that as the length, so the report came back empty.

Still to do: steps 6.2, 6.5 and 6.6 below (a login in the browser, one full audit, the usage page).

## 1. The private Blob store (done 2026-11-23)

Store `audit-platform-private` (`store_DKt6f8ffQrOKXk8t`, private, region `fra1`) is connected to the project's Production environment under the prefix `PLATFORM_BLOB`, which gave `PLATFORM_BLOB_READ_WRITE_TOKEN`. The public store of the live app is untouched: `BLOB_STORE_ID` still names `store_hsH12rqmrTtK…`.

The prefix matters. The live app and the old workflow find the public store through `BLOB_STORE_ID` in all three environments (the workflow reads the Development one), and a second store connected with the default prefix `BLOB` would claim that name. `vercel blob create-store` always connects with the default prefix, so the store was created through the API without a connection and then connected with the prefix (`POST /v1/storage/stores/<id>/connections` with `envVarPrefix`), which is what the dashboard's "custom prefix" does.

Checked against the real store with `web/scripts/check-blob-store.ts`: put, get, list, delete, a presigned upload sent the way the worker sends it, an overwrite, and that a presigned address refuses another pathname (403). All pass. Run it again after any change to the store code:

```bash
PLATFORM_BLOB_READ_WRITE_TOKEN='<from Vercel>' yarn --cwd web tsx scripts/check-blob-store.ts
```

## 2. Admins (three created 2026-11-23)

For each further person, run with the **unpooled** Neon address (Vercel → project → Settings → Environment Variables → `DATABASE_URL_UNPOOLED`):

```bash
DATABASE_URL='<DATABASE_URL_UNPOOLED>' yarn --cwd web admin:create --email=you@company.com --name="You"
```

It asks for a password (12+ characters). Because admins exist from the start, the shared password is never used and `INTERNAL_PASSWORD_HASH` stays unset. Later: the same command with an existing email sets a new password, and `--disable` stops a person from logging in.

## 3. Vercel project settings (set; listed for reference)

- **Root Directory:** `web` (already so).
- **Function duration:** the team is on the Pro plan; the status route and the cron route ask for 300 seconds.

| Variable | Value |
|---|---|
| `PLATFORM_MODE` | `production` |
| `APP_URL` | `https://audit-tool-focusreactive.vercel.app` |
| `DATABASE_URL` | set by the Neon integration (pooled) |
| `PLATFORM_BLOB_READ_WRITE_TOKEN` | set by connecting the private store (step 1) |
| `GITHUB_TOKEN` | already there; `GITHUB_DISPATCH_TOKEN` overrides it |
| `WORKER_REPOSITORY`, `WORKER_REPOSITORY_ID` | `o8o0o8o/audit-tool` and its numeric id |
| `WORKER_OIDC_AUDIENCE` | `audit-platform` |
| `SESSION_SECRET`, `REPORT_TOKEN_SECRET`, `CRON_SECRET` | generated |

Optional: `PAGE_DATA_RETENTION_DAYS` (default 90), `QUEUE_CAP_INTERNAL` (default 2 audits at a time).

If the production address changes (a custom domain), change `APP_URL` and the repository variables `PLATFORM_APP_URLS` and `PLATFORM_CRON_URL` together: they must match exactly.

## 4. GitHub repository settings (set; listed for reference)

Variables `PLATFORM_APP_URLS`, `PLATFORM_OIDC_AUDIENCE`, `PLATFORM_CRON_URL`; secret `PLATFORM_CRON_SECRET`. `CRUX_API_KEY` was already a secret. Add `ANTHROPIC_API_KEY` only for the LLM passes, and `WPSCAN_API_TOKEN` only for WordPress vulnerability data.

## 5. Merge and deploy

```bash
git push origin platform-api-local
git checkout main && git merge --ff-only platform-api-local && git push origin main
```

If the Vercel project deploys from `main`, this push deploys it. The two new workflows (`platform-worker.yml`, `platform-cron.yml`) become usable the moment they are on `main`: GitHub starts a dispatch or a schedule only for a workflow file on the default branch.

## 6. Check it works, in this order

1. **App is up:** open `<address>/api/health`; expect 200.
2. **Login:** open `<address>` and log in with your email and password.
3. **Quick scan:** start a Quick scan of a small site from "New audit". Then watch for these:

   | What should happen | If it does not |
   |---|---|
   | A "Platform worker" run appears in GitHub Actions within seconds | Dispatch failed. Vercel logs show `[dispatch] GitHub refused the run`: the existing `GITHUB_TOKEN` cannot start workflows in this repository, or the workflow is not on `main`. |
   | The run passes "Validate inputs" | `PLATFORM_APP_URLS` does not contain `APP_URL` exactly, or the audience variable is missing. |
   | The worker registers and the audit shows `running` | `401 worker identity not valid`: the audience or `WORKER_REPOSITORY` does not match, or GitHub's token fields differ from what the code expects. |
   | The worker uploads its files | `upload …: 4xx`: unexpected, since the same request passed against the real store (step 1); the response text says why. |
   | The audit turns `succeeded` shortly after the run ends | Loading failed; the Vercel log of `/api/worker/status` has the reason. |
   | The report opens from the audit page | Reading from the private store failed. |

   The first run takes a few minutes, mostly installing Chromium on the runner.

4. **Cron:** in GitHub Actions, run "Platform cron" by hand once. It should print `tick: HTTP 200`.
5. **Full audit:** run one full audit of a small site; it uploads far more files than a quick scan.
6. **Usage:** open `/internal/usage` and check your audits are under your name.

## 7. If it goes wrong

In Vercel, promote the previous production deployment. The old app and old workflow still work, because nothing of theirs was changed or deleted. The new database and Blob store can be left as they are.

## 8. The public site

The public form at `/` is on in production through `PUBLIC_SCANS=on` (2026-11-23), **without a bot check**. Its protection is the limits: 3 new scans per hour from one address, at most 5 public scans queued or running (one runs at a time; `QUEUE_CAP_PUBLIC` changes that), 100 public scans in 24 hours over all visitors, and a repeat of the same target within a day opens the scan that exists. Public scans are quick scans or single pages, passive, and their screenshots expire after 30 days.

To add the bot check later: in Cloudflare → Turnstile, add a widget for `audit-tool-focusreactive.vercel.app`, set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` on the Vercel project (Production) and redeploy. To close the public site: remove `PUBLIC_SCANS` (and the keys) and redeploy; `/` then redirects to `/internal`.

Optional: `PUBLIC_CONTACT_EMAIL`, the address for deletion requests from the result page (without it the link goes to the contact page).

## 9. Giving someone the MCP server

An admin creates an API key at `/internal/keys` (name, scopes) and hands the key over once; the person adds the server to their client with the app's address plus `/api/mcp` and the key as a bearer token. The steps, the scopes and the limits are in [`web/README.md`](../web/README.md), "Using the MCP server".

## What the first users should know

- **Reports are as the run stored them:** no History section, and they do not change when report code changes.
- **Concurrency:** two internal audits at a time; a third waits in the queue.
- **Actions logs are public:** the repository is public, so each worker run's log shows the audited URL.
- **Stuck audits recover slowly:** a dead worker is noticed after 10–15 minutes, plus however late GitHub runs the 5-minute schedule. On the first day (2026-11-23) the schedule had not fired once in its first 95 minutes on `main`; only a run started by hand had. Until it fires, nothing recovers an audit whose worker dies; audits that finish normally do not need it. If it stays silent, the tick needs another trigger.
- **Old page data:** audits lose their page data after 90 days; findings and reports stay.
- **Not tried yet:** resuming or continuing a large audit, which reads big files back through the app.
