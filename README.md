# Audit Tool

Automated website audit. Crawls a site, runs ~50 SEO / performance / accessibility / security / privacy analyzers, captures evidence for representative pages (screenshots, axe-core, network logs, Lighthouse scores), and produces a curated PDF report styled after the audits a human consultant would write.

## Pipeline

```
URL ──▶ Phase 1: mechanical crawl ──▶ artifacts/ ──▶ Phase 2: curated PDF ──▶ Phase 3: verification (--verify)
                                                    (optional LLM narrative)     (separate verified report)
                                                                          └──▶ Phase 4: competitive content research (--content-research)
                                                                               (competitor crawl + gap matrix + content plan)
```

**Phase 1** is fully deterministic — Playwright crawl + analyzers + evidence capture for sampled pages. No LLM, no judgement calls.

**Phase 2** consumes the Phase 1 artifacts and produces `audit-report.pdf` in the human-audit style: cover, summary with Top 3 Priority Issues + Quick Wins + Long-term Recommendations, six sections (Performance / SEO / Privacy / Accessibility / UX / Technical), and an appendix with screenshots + PSI Lighthouse scores per representative page. Template-driven by default; opt into Claude prose (and the other AI passes) with `--llm`. Persists `phase2-state.json` — the exact render inputs — as the boundary the next phase re-renders from.

**Phase 4** (opt-in via `--content-research`) answers a different question — *what should we write next?* It crawls a bounded sample of competitor content (supply hosts with `--competitors=a.com,b.com`, or let `--llm` discover them), clusters each side's topics with the same engine used for our own site, and computes the **competitive topic-coverage gap**: topics competitors cover that we cover thinly or not at all, plus depth gaps where our pages are far shorter than the leading competitor's. It emits a **separate** `content-research-report.{md,pdf}` with the gap matrix and a **prioritized content plan** (each item: title, target keywords, format, length, brief — LLM-synthesized with `--llm`, templated otherwise), plus a versioned `content-research-state.json`. Self-contained and keyless by default; drop a `content-research-data.json` (`{ keywords: [{ term, volume, difficulty }] }`) to enrich the ranking with real search demand. With no competitors and no LLM it falls back to surfacing your own thinnest topics. Standalone re-runnable via `runContentResearchPhase(runDir)` from `lib/phase4/phase4-runner.ts`.

**Phase 3** (opt-in via `--verify`) fact-checks the report Phase 2 just wrote: it re-fetches each finding's example(s) live — all severities incl. LOW, sampling up to 3 distinct pages for a multi-page finding — and re-asserts the claim against the current page(s), then emits a **separate** `audit-report.verified.{md,pdf}` (confirmed findings badged ✓ Verified, AI-confirmed ones ✓ Verified (AI), refuted ones dropped into `audit-report.refuted.md`; the main report is never touched). Each `unverified` finding carries a categorized reason (the banner breaks them down), a fully-sampled clean multi-page finding can refute, response-header/robots checkers and an LLM stage (API or keyless `claude` CLI) run live, and AI-discovered findings are re-checked against fresh screenshots (vision, API). Standalone re-runnable: everything it needs is on disk, so you can re-verify an existing audit at any later time without re-crawling — `runVerifyPhase(runDir)` from `lib/phase3/verify-runner.ts`.

## Installation

```bash
yarn
npx playwright install
```

## Quick start

### Minimal audit

```bash
npx tsx start.ts --origin=https://example.com
```

Output: `audit-results/example.com/<timestamp>/audit-report.pdf`

### Full audit (recommended)

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # optional; --llm uses it, else the keyless claude CLI
export CRUX_API_KEY=AIza...           # optional — unblocks PSI rate limits

npx tsx start.ts \
  --origin=https://example.com \
  --perf \
  --repo=/path/to/local/source \
  --llm
```

This runs the whole flow: crawl + Lighthouse field data + PSI lab scores per representative page + source-code analysis + Claude-generated narrative prose.

## CLI flags

| Flag                  | Default       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--origin=<url>`      | (required)    | Website to audit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--perf`              | off           | Capture Core Web Vitals + per-URL PSI Lighthouse scores (mobile + desktop) for sampled pages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--repo=<path>`       | off           | Run source-code analysis against a local repo (framework detection, Next.js anti-patterns, package.json hygiene)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--llm`               | off           | Enable all optional LLM passes (one flag): rewrite per-section "Analysis" prose; find emergent functional/UX bugs the rule-based analyzers miss (dead buttons, CTAs to 404s, never-terminating pagination, broken layout) via screenshot + signals; reason over the source repo (with `--repo`) to find issues no rule enumerates, confirm whether the source explains each crawl finding, and propose code-aware fixes; and revalidate findings (drop confirmed dupes/false positives) before the final report. Uses `ANTHROPIC_API_KEY`, else the keyless `claude` CLI, else degrades silently. AI findings are additive (never drop a deterministic one), tagged "🔍 AI-discovered". Disk-cached. ~$0.02–$0.05 per sampled page. |
| `--verify`            | off           | Phase 3: fact-check every reported finding and emit a separate `audit-report.verified.{md,pdf}` (the normal report is never touched). Default is a live re-fetch of each finding's first example; `SEO_AUDIT_VERIFY_OFFLINE=1` selects the deterministic disk pass (no network), whose stage 2 hands the leftovers to Claude via whichever transport is available — an injected `verify-verdicts.json`, the API (`ANTHROPIC_API_KEY`), or, with **no key**, the `claude` CLI spawned headless (disable with `SEO_AUDIT_SKIP_CLAUDE_CLI=1`). Standalone re-runnable: re-verify an existing audit anytime via `runVerifyPhase(runDir)` — no re-crawl. |
| `--concurrency=<n>`   | 5             | Parallel page workers (1–20)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--limit=<n>`         | none          | Stop after N pages (useful for large sites)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--save-html`         | off           | Save full HTML snapshot of every crawled page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--screenshots`       | off           | Capture mobile + desktop screenshots for sampled pages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--evidence-cap=<n>`  | 10            | Cap on representative-page samples (1–100)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--no-evidence`       | —             | Skip the evidence pass entirely (no screenshots, no axe-core, no PSI)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--no-phase2`         | —             | Skip curated PDF generation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--content-research`  | off           | Phase 4: competitive content research — crawl competitor content, compute the topic-coverage gap, and emit a separate `content-research-report.{md,pdf}` + content plan. Keyless by default; with `--llm` it discovers competitors (when none supplied) and synthesizes the plan. Standalone re-runnable. |
| `--competitors=<list>`| none          | Competitor hosts for `--content-research`: comma-separated (`a.com,b.com`) or a path to a file (one URL per line). Optional — omit to let `--llm` discover them. Also settable via `competitors: []` in `.seoauditrc`. |
| `--proceed`           | —             | Resume from the most recent checkpoint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--exclude=<pattern>` | none          | Skip URLs matching a glob                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--config=<path>`     | `.seoauditrc` | Custom config file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--init-config`       | —             | Write a sample `.seoauditrc` and exit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--ci[=<threshold>]`  | —             | Exit code 1 if overall score < threshold (default 70)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--json`              | —             | Output a machine-readable summary to stdout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--verbose` / `-v`    | —             | Verbose logging                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Output layout

```
audit-results/
└── example.com/
    ├── audit-history.json.gz          # snapshots for trend tracking
    └── <YYYY-MM-DD_HH-MM-SS>/
        ├── audit-report.pdf            # Phase 2 curated PDF
        ├── audit-report.md             # source markdown
        ├── audit-report.html           # styled HTML (renderer input)
        ├── phase2-state.json           # Phase 2 → Phase 3 boundary (render inputs for standalone re-verify)
        ├── audit-report.verified.pdf   # Phase 3 (--verify): re-checked report, per-issue status badges
        ├── audit-report.verified.md    # its source markdown
        ├── audit-report.refuted.md     # Phase 3: findings DROPPED as refuted, with reasons (omitted when none)
        ├── content-research-report.pdf # Phase 4 (--content-research): competitive gap matrix + content plan
        ├── content-research-report.md  # its source markdown (+ .html)
        ├── content-research-state.json # Phase 4 render inputs (gaps, plan) for standalone re-run
        ├── content-research-data.json  # OPTIONAL input: { keywords:[{term,volume,difficulty}] } to enrich ranking
        ├── example.com.html            # Phase 1 engineer-facing data dump
        ├── manifest.json.gz            # index + evidence section
        ├── analysis.json.gz            # site-wide findings + summary
        ├── metadata.json.gz            # robots / sitemap / CrUX / timing
        ├── incoming-links.json.gz
        ├── repo-analysis.json.gz       # only with --repo
        ├── pages/                      # per-batch raw page JSON
        └── evidence/                   # per-page evidence for sampled URLs
            └── <safe-filename>/
                ├── _meta.json
                ├── screenshot.mobile.png
                ├── screenshot.desktop.png
                ├── axe.json
                ├── requests.json
                ├── accessibility.json
                ├── psi.mobile.json     # only with --perf
                └── psi.desktop.json
```

## What gets checked

**Performance.** Core Web Vitals (LCP / CLS / INP / FCP / TTFB) lab + field, render-blocking resources, font strategy (woff/woff2, font-display, preload coverage), image optimization (srcset correctness, DPR-aware sizing, format), JS/CSS coverage with critical-CSS recommendation, third-party payload, caching.

**SEO.** Meta tags, headings, canonicals, hreflang reciprocity (Google's "must list itself" + fully-qualified URL rules), structured data, sitemap quality (404s, 3xx redirects, `changefreq=always`+`priority=1.0` abuse, trailing-slash duplicates), internal linking, PageRank, broken outbound links, AI search readiness (llms.txt, GPTBot/ClaudeBot rules).

**Privacy / GDPR.** Consent banner detection, tracking scripts before consent, cookie lifespan (>365 days), third-party cookies without consent, privacy policy presence.

**Accessibility.** axe-core 4.x scan on every sampled page + hand-rolled heuristics: ARIA, color contrast, focus states, form labels, semantic landmarks, keyboard navigation, touch targets.

**Security.** HTTPS, CSP, X-Frame-Options, HSTS, mixed content, SRI, cookies, permissions-policy.

**UX / UI.** Responsive layout, mobile viewport, form accessibility, CTA detection.

**Source code (with `--repo`).** Framework + version detection (Next.js / Nuxt / Gatsby / Astro). For Next.js: `cache: "no-store"` fetcher anti-pattern, `ssr: false` dynamic imports of main content, `force-dynamic` exports on static-looking routes, full-lib `lodash` imports, CSS inlined in `_app.tsx`. Package.json: wildcard semver ranges, Next/React major-version mismatch, multiple styling solutions. Add `--llm` to layer Claude on top of `--repo` (find issues no rule enumerates, confirm crawl findings against the source, suggest code-aware fixes) — additive only, grounded by the deterministic result.

**Site-wide.** Duplicate titles/descriptions, near-duplicate content (Jaccard similarity), keyword cannibalisation, orphan pages, content gap analysis, link depth.

## Programmatic usage

```typescript
import { SEOData } from './lib/seo-data';
import { runPhase2 } from './lib/phase2/phase2-runner';
import { runVerifyPhase } from './lib/phase3/verify-runner';

const seo = new SEOData('https://example.com', false, true, false, 5, null, {
  evidence: true,
  evidenceCap: 10,
  cruxApiKey: process.env.CRUX_API_KEY ?? null,
});

await seo.audit();

const pdfPath = await runPhase2(seo.fileManager.resultsDir, {
  llmNarrative: !!process.env.ANTHROPIC_API_KEY,
});

// Phase 3 (optional, re-runnable anytime): verify the findings against the
// live site and emit audit-report.verified.{md,pdf} + audit-report.refuted.md.
await runVerifyPhase(seo.fileManager.resultsDir, { verbose: true });

console.log('Audit done:', pdfPath);
```

## Other commands

```bash
# Export to CSV
npx tsx generateCSV.ts audit-results/example.com/<timestamp>/SEOAnalysis__example.com.json.gz

# List audit history for a domain
npx tsx historyManager.ts list example.com

# Save audit to history
npx tsx historyManager.ts save audit-results/example.com/<timestamp>/SEOAnalysis__example.com.json.gz

# Compare two audits
npx tsx generateComparison.ts example.com 0 1
```

## Configuration file

`--init-config` writes a sample `.seoauditrc`. Override any threshold or crawl setting:

```json
{
  "thresholds": {
    "TTFB": 1000,
    "LCP": 3000,
    "CLS": 0.15,
    "TITLE_MIN": 40,
    "TITLE_MAX": 70
  },
  "crawl": {
    "concurrency": 10,
    "timeout": 45000
  },
  "excludeUrls": ["/admin/*", "/staging/*", "*.pdf"]
}
```

## Wall time and cost

| Site size   | Crawl time | LLM cost (with `--llm`) |
| ----------- | ---------- | --------------------------------- |
| 50 pages    | ~5 min     | ~$0.03                            |
| 500 pages   | ~30 min    | ~$0.03                            |
| 5 000 pages | ~3–5 hr    | ~$0.03                            |

PSI Lighthouse calls dominate wall time when `--perf` is on without a `CRUX_API_KEY` (anonymous rate limit ≈ 1 req/sec). With a key, generous quota (25 000/day).

## Graceful degradation

Every optional step degrades silently if its dependency is unavailable:

- `--llm` without `ANTHROPIC_API_KEY` → uses the keyless `claude` CLI if on `PATH`, else degrades silently (templated prose, all findings kept)
- `--perf` when PSI quota is exhausted → PSI files skipped, audit completes normally
- `--repo` with an invalid path → repo section omitted
- `--evidence-cap=N` exceeding what the sampler can find → captures what it can

You always get a PDF.

## Resuming after interruption

If the process crashes or you hit Ctrl-C, `start.ts` auto-restarts up to 3 times with `--proceed`. You can also resume manually:

```bash
npx tsx start.ts --origin=https://example.com --proceed
```

Resume loads checkpoint + archive files automatically.

## Environment variables

| Variable                    | Purpose                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`         | Enables the API transport for the `--llm` passes (and the `--verify` LLM fallback). Without it, those passes fall back to spawning the `claude` CLI if it's on `PATH`, else degrade silently. |
| `CRUX_API_KEY`              | API key for CrUX / PageSpeed Insights lab data (`--perf`). Works keyless at reduced rate limits.                                                                                                              |
| `NODE_HEAP_SIZE`            | Override the Node `--max-old-space-size` (MB) for very large crawls.                                                                                                                                          |
| `SEO_AUDIT_VERIFY_OFFLINE`  | `1` → `--verify` uses the deterministic on-disk pass instead of the default live re-fetch (reproducible, no network, no key).                                                                                 |
| `SEO_AUDIT_SKIP_CLAUDE_CLI` | `1` → never spawn the `claude` CLI as an LLM transport.                                                                                                                                                       |
| `SEO_AUDIT_CLAUDE_CLI_BIN`  | Override the `claude` CLI binary path/name.                                                                                                                                                                   |
| `SEO_AUDIT_ALLOW_PRIVATE`   | `1` → disable the SSRF guard's private/internal-host block (for intentionally auditing internal/local sites). A target whose host matches the audit origin is allowed without this.                           |

The LLM passes additionally rely on the `claude` CLI being on `PATH` when no API key is set.

## Web dispatcher (Vercel)

`web/` is a small Next.js app that starts audits from a browser and shows their reports. Audits can't run inside Vercel functions (Playwright, long runtimes), so the page dispatches `.github/workflows/audit.yml` through the GitHub API; the workflow runs `npx tsx start.ts`, then uploads the run folder to Vercel Blob under `audits/<run_id>/` together with a `status.json` the page reads.

**Vercel project**

- Import the repo and set **Root Directory** to `web`.
- Link a Vercel Blob store (provides `BLOB_READ_WRITE_TOKEN`).
- Environment variables: `GITHUB_TOKEN` (fine-grained token, repository access to this repo, **Actions: read & write**), `DISPATCH_SECRET` (required; every dispatch is refused with a 500 while it is unset), and optionally `DISPATCH_RATE_LIMIT` (dispatches per IP per window, default 5), `GITHUB_OWNER` (default `o8o0o8o`), `GITHUB_REPO` (default `audit-tool`), `GITHUB_WORKFLOW` (default `audit.yml`), `GITHUB_REF` (default `main`). See `web/.env.example`.

**GitHub repository secrets**

- `BLOB_READ_WRITE_TOKEN` — the same Blob store token, so the workflow can upload results.
- Optional: `ANTHROPIC_API_KEY` (for `--llm` / `--verify` LLM stages), `CRUX_API_KEY`.

Dispatch requires the `DISPATCH_SECRET` value in the `x-dispatch-key` header; without `DISPATCH_SECRET` configured the endpoint fails closed and refuses every dispatch. A best-effort per-IP rate limit (`DISPATCH_RATE_LIMIT`, per serverless instance) answers excess requests with 429. Private/localhost targets are rejected by hostname; the crawler's own URL guards still apply on the runner. Results are also kept for 14 days as a workflow artifact.

## Development

```bash
yarn              # install
npx playwright install

yarn typecheck    # tsc --noEmit
yarn lint         # eslint .   (yarn lint:fix to autofix)
yarn format       # prettier --write   (yarn format:check to verify)
yarn test         # tsx --test tests/**/*.test.ts
```

Run `typecheck`, `lint`, `format:check`, and `test` before committing — these are the same checks a CI workflow should gate on.

## License

ISC

## Author

Sergey Labut
