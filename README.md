# Audit Tool

Automated website audit. Crawls a site, runs ~50 SEO / performance / accessibility / security / privacy analyzers, captures evidence for representative pages (screenshots, axe-core, network logs, Lighthouse scores), and produces a curated PDF report styled after the audits a human consultant would write.

## Pipeline

```
URL ──▶ Phase 1: mechanical crawl ──▶ artifacts/ ──▶ Phase 2: curated PDF
                                                    (optional LLM narrative)
```

**Phase 1** is fully deterministic — Playwright crawl + analyzers + evidence capture for sampled pages. No LLM, no judgement calls.

**Phase 2** consumes the Phase 1 artifacts and produces `audit-report.pdf` in the human-audit style: cover, summary with Top 3 Priority Issues + Quick Wins + Long-term Recommendations, six sections (Performance / SEO / Privacy / Accessibility / UX / Technical), and an appendix with screenshots + PSI Lighthouse scores per representative page. Template-driven by default; opt into Claude prose with `--llm-narrative`.

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
export ANTHROPIC_API_KEY=sk-ant-...   # required only for --llm-narrative
export CRUX_API_KEY=AIza...           # optional — unblocks PSI rate limits

npx tsx start.ts \
  --origin=https://example.com \
  --perf \
  --repo=/path/to/local/source \
  --llm-narrative
```

This runs the whole flow: crawl + Lighthouse field data + PSI lab scores per representative page + source-code analysis + Claude-generated narrative prose.

## CLI flags

| Flag | Default | Purpose |
|---|---|---|
| `--origin=<url>` | (required) | Website to audit |
| `--perf` | off | Capture Core Web Vitals + per-URL PSI Lighthouse scores (mobile + desktop) for sampled pages |
| `--repo=<path>` | off | Run source-code analysis against a local repo (framework detection, Next.js anti-patterns, package.json hygiene) |
| `--llm-narrative` | off | Use Claude to rewrite the per-section "Analysis" paragraphs. Requires `ANTHROPIC_API_KEY`. Disk-cached so re-renders are free. ~$0.02–$0.03 per audit at Sonnet pricing. |
| `--llm-findings` | off | Use Claude (vision + signals) to find emergent functional/UX bugs the rule-based analyzers miss — dead buttons, CTAs to 404s, never-terminating pagination, forms posting nowhere, visually broken layout. Reasons over each representative page's screenshot + structured signals; findings merge into their section tagged "🔍 AI-discovered". Requires `ANTHROPIC_API_KEY`. Disk-cached. ~$0.02–$0.05 per sampled page. |
| `--verify` | off | Fact-check every reported finding against the crawl data and emit a separate `audit-report.verified.{md,pdf}` (the normal report is never touched). Stage 1 is deterministic (no network). Stage 2 hands the leftovers to Claude via whichever transport is available — an injected `verify-verdicts.json`, the API (`ANTHROPIC_API_KEY`), or, with **no key**, the `claude` CLI spawned headless. Disable the CLI spawn with `SEO_AUDIT_SKIP_CLAUDE_CLI=1`. |
| `--concurrency=<n>` | 5 | Parallel page workers (1–20) |
| `--limit=<n>` | none | Stop after N pages (useful for large sites) |
| `--save-html` | off | Save full HTML snapshot of every crawled page |
| `--evidence-cap=<n>` | 10 | Cap on representative-page samples (1–100) |
| `--no-evidence` | — | Skip the evidence pass entirely (no screenshots, no axe-core, no PSI) |
| `--no-phase2` | — | Skip curated PDF generation |
| `--proceed` | — | Resume from the most recent checkpoint |
| `--exclude=<pattern>` | none | Skip URLs matching a glob |
| `--config=<path>` | `.seoauditrc` | Custom config file |
| `--init-config` | — | Write a sample `.seoauditrc` and exit |
| `--ci[=<threshold>]` | — | Exit code 1 if overall score < threshold (default 70) |
| `--json` | — | Output a machine-readable summary to stdout |
| `--verbose` / `-v` | — | Verbose logging |

## Output layout

```
audit-results/
└── example.com/
    ├── audit-history.json.gz          # snapshots for trend tracking
    └── <YYYY-MM-DD_HH-MM-SS>/
        ├── audit-report.pdf            # Phase 2 curated PDF
        ├── audit-report.md             # source markdown
        ├── audit-report.html           # styled HTML (renderer input)
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

**Source code (with `--repo`).** Framework + version detection (Next.js / Nuxt / Gatsby / Astro). For Next.js: `cache: "no-store"` fetcher anti-pattern, `ssr: false` dynamic imports of main content, `force-dynamic` exports on static-looking routes, full-lib `lodash` imports, CSS inlined in `_app.tsx`. Package.json: wildcard semver ranges, Next/React major-version mismatch, multiple styling solutions.

**Site-wide.** Duplicate titles/descriptions, near-duplicate content (Jaccard similarity), keyword cannibalisation, orphan pages, content gap analysis, link depth.

## Programmatic usage

```typescript
import { SEOData } from './lib/seo-data';
import { runPhase2 } from './lib/phase2/phase2-runner';

const seo = new SEOData('https://example.com', false, true, false, 5, null, {
  evidence: true,
  evidenceCap: 10,
  cruxApiKey: process.env.CRUX_API_KEY ?? null,
});

await seo.audit();

const pdfPath = await runPhase2(seo.fileManager.resultsDir, {
  llmNarrative: !!process.env.ANTHROPIC_API_KEY,
});

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

| Site size | Crawl time | LLM cost (with `--llm-narrative`) |
|---|---|---|
| 50 pages | ~5 min | ~$0.03 |
| 500 pages | ~30 min | ~$0.03 |
| 5 000 pages | ~3–5 hr | ~$0.03 |

PSI Lighthouse calls dominate wall time when `--perf` is on without a `CRUX_API_KEY` (anonymous rate limit ≈ 1 req/sec). With a key, generous quota (25 000/day).

## Graceful degradation

Every optional step degrades silently if its dependency is unavailable:

- `--llm-narrative` without `ANTHROPIC_API_KEY` → falls back to templated prose with top-3 finding names
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

## License

ISC

## Author

Sergey Labut
