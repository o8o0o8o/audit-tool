# Report Rules — Ranking, Severity, Categorization & Determinism

These are the rules that govern how the curated Phase 2 report (markdown + PDF)
turns raw analyzer findings into a ranked, client-facing document. They live in
**code** so every run produces the same report for everyone — nothing here
depends on who runs the audit, on what machine, or in what order pages happen to
crawl.

If you change ranking, severity, or categorization behavior, update both the
code and this document, and add/adjust a test in `tests/analyzers.test.ts`.

## 0. Audience & tone — the report is a client-facing deliverable

The Phase 2 report is read by the **site owner**, not a developer. Optimise for
that reader and for honesty over flattery:

- **No internal/dev jargon.** No CLI flags (`--perf`), no source paths
  (`lib/analyzers/…`), no "URL template" or tooling internals in the report.
- **No filler.** Low-signal boilerplate checks (web-app manifest, service
  worker, theme-color, Apple touch icon, noscript, Shadow DOM, …) collapse into
  a compact "Minor & informational" list rather than headline findings.
  Screenshots are captured to `evidence/` (they feed the `--llm` findings pass) but are
  **not** padded into the report body.
- **Honest scores.** The overall score is min-aware
  (`mean·0.55 + worst·0.45`, `SCORING.OVERALL_MEAN_WEIGHT`) so a failing category
  can't be masked by a weighted mean. Severity must match reality — a missing
  meta description is MEDIUM, not CRITICAL (see section 3).
- **Impact-first prose.** Analysis paragraphs lead with the single
  highest-impact finding and its reach, not a generic count.

## 1. Category priority

Findings are grouped and ranked by category before anything else. Priority order
(highest first):

```
SEO  >  Performance  >  UX  >  Privacy/Security  >  Accessibility  >  Technical
```

- Defined by `SECTION_ORDER` → `SECTION_RANK` in `lib/phase2/phase2-runner.ts`.
- `privacy` maps to the **Security** score (GDPR/cookie gaps are what the
  security score penalises).
- This order leads in **every** ranked list — the per-section bodies *and* the
  cross-section summary lists (Top Priority / Quick Wins / Long-term). A
  widespread low-priority finding (e.g. a CSS-level accessibility issue on every
  page) must never outrank a higher-priority SEO/security finding.

## 2. Ranking within a list

The comparator is `byImportance` (and `byQuickWinImportance` for quick-win
items). Keys, in order:

1. **Category rank** (section 1).
2. **Severity band** — critical → high → medium → low.
3. **Impact score** — `severity × catalog-tier × category-value × breadth`
   (`impactScore`). Breadth (pages affected) saturates logarithmically.
4. **Stable message/issue text** (`localeCompare`) — the final tiebreaker.

Never rank a report list by raw occurrence `count`. Count-only ranking surfaces
whatever is most *widespread* rather than most *important*. Occurrence count
only decides the **"systemic"** label on a finding, never its position.

## 3. Severity moderation

A single analyzer signal must not read as critical/high when its category
objectively scored well. `moderateSeverities` caps (never raises) severity
against the measured `categoryScores`:

- category score ≥ 90 → cap at **medium**
- category score ≥ 75 → cap at **high** (no critical)

Findings the catalog vets as error-tier (`isCataloguedErrorTier`: mixed content,
noindex-in-sitemap, …) are exempt — known-serious regardless of the average.

## 4. Categorization

`categorize()` in `lib/phase2/categorize.ts` routes a finding to its section by
keyword. Mis-routing defeats the priority order, so when a finding ranks lower
than expected, check its category first. Notably, these are **SEO**, not the
`technical` catch-all: thin/insufficient content, E-E-A-T / author / YMYL
signals, and crawl-budget waste.

### Presets: section selection and check filtering

A role or custom preset (`--preset=sales|marketing|seo|custom`, see
`lib/presets.ts`) narrows what a report shows; it never changes how a finding
is ranked, categorized or de-duplicated.

- **Sections.** `resolvePreset` returns `phase2Sections` and `htmlSections`.
  `buildReportMarkdown` renders only those Phase 2 sections, in the preset's
  order (not `SECTION_ORDER`); `generateHTML` renders only those HTML sections,
  nav links and tabs, in the preset's order, with the config block last. The
  cover, purpose and summary always render.
- **Checks.** A finding belongs to its `categorize()` section plus any keyword
  family in `findingCheckGroups` (`security`, `content`, `cta`, `technology`,
  `analytics`). With `--checks`, `preparedDetails` keeps only findings in a
  selected group, before section routing — so the summary, sections, LLM
  narratives and the HTML issue lists all agree. AI-discovered anomalies are
  filtered the same way.
- **Phase 3.** `phase2-state.json` stores `sections` and `checks`;
  `runVerifyPhase` applies both, so the verified and refuted reports never
  bring back a filtered finding. A state file without them renders the full
  report, unfiltered.
- **No preset** (or `quick`/`standard`/`deep`) renders byte-identical output to
  the pre-preset report — guarded by the golden files in
  `tests/fixtures/report-fixture/golden/`.

## 5. De-duplication

The same underlying issue is sometimes reported two ways — a per-page analyzer
finding and a site-wide validator restatement (e.g. `Form inputs missing labels`
vs `52 form inputs across site missing labels`). These must fold to one entry
via `DEDUP_GROUPS` in `lib/phase2/consolidate.ts`; otherwise the same issue
appears twice across summary sub-sections.

**Redirect sources are not distinct pages.** A requested URL that redirected
(e.g. the trailing-slash twin `/x` → `/x/`, or an old path → new path) is
followed to its destination, so the stored `PageInfo` holds the *destination's*
title/description/content keyed under the *requested* URL. Site-wide validators
that compare pages across the crawl (`duplicate-checker`, `content-similarity-analyzer`)
must skip pages with `hasRedirects`, or the destination's own title/content
registers as a "duplicate"/"near-duplicate" of itself — the classic
trailing-slash inflation. The redirect itself is already surfaced as a per-page
redirect finding.

**Tier-twin findings (one metric, two severity bands) must not exist.** A
per-page analyzer measuring a single quantity must emit **one** message string
regardless of which threshold band the page falls in — the band it crossed goes
in the *detail*, never the title. Splitting into two tier-named titles (the old
`Large DOM size` warning-band finding vs `Excessive DOM size` failure-band
finding in `dom-complexity-analyzer.ts`) reads as two redundant findings for one
problem, because site-wide aggregation surfaces both bands' page populations at
once. For the same reason the message's severity must be **fixed**, not derived
per page from the band: `ErrorAggregator.addError` keys by message and keeps the
*first-seen* severity, so a per-page-varying severity would make the finding's
severity depend on the non-deterministic crawl-completion order (a §6 violation).
Collapsed the same way (one message, fixed **MEDIUM** severity, band in the
detail): **URL length** — `URL is too long` (the `URL is longer than
recommended` warning-band twin was removed; `lib/utils.ts`); **HTML size** —
`Large HTML document` (the `HTML document exceeds 3MB` failure-band twin was
removed; `technical-seo-analyzer.ts`); **third-party payload** — `Large
third-party payload` (the `Excessive third-party payload` failure-band twin was
removed; `third-party-analyzer.ts`). When collapsing a twin, also re-key its
downstream identity maps — `fix-recommendations-extended.ts`, `seo-catalog.ts`,
`score-calculator.ts`, `nextjs-recommendations.ts` — and its
`lib/phase3/live-verifier.ts` matcher(s) + `lib/phase2/benchmarks.ts` regex onto
the surviving canonical, or the fix/benchmark/verification silently drops.

This is distinct from the deliberate *per-page vs site-wide* twins above (e.g.
`Large web font payload` / `Excessive web font payload`), which describe
different scopes and are reconciled by `DEDUP_GROUPS` — not two bands of the same
per-page measurement.

**Form-action findings are unified.** A data-collection form that self-posts via
GET (empty/missing/`#`/`javascript:` action + GET method + a non-search data
field) emits one deterministic finding — `Form submits to itself via GET`
(`form-accessibility-analyzer.ts`, fixed MEDIUM) — instead of the LLM anomaly
pass free-forming per-form titles ("Contact form has empty action", "Sign Up
form uses GET", …). The anomaly prompt (`llm-anomaly.ts`) also pins the stable
`kind` slug `form-empty-action` for any such defect so per-page variants
consolidate. Empty-action forms that are search boxes or POST self-submits are
NOT flagged — those are valid HTML, and flagging them re-introduces false
positives.

## 6. Determinism contract

**Goal: the same crawl data produces a byte-identical report for everyone.**

Pages crawl concurrently, so the order findings are collected in — the insertion
order of `analysis.details` keys and of each finding's `examples` array — is
**not** deterministic. Three rules keep that non-determinism out of the report:

1. **Every output-affecting sort is a total order.** All comparators end in a
   stable string tiebreaker (`byImportance`, `byQuickWinImportance`, the
   quick-win effort sort, and `ScoreCalculator.identifyQuickWins`). Without it,
   JS's stable sort leaks the insertion order into tied findings.
2. **Example samples are sorted worst-first before slicing.** The "Affected
   pages" list and the quick-win `examples` are ordered by the metric each
   example embeds (request count, unused-code size, TBT, …) via
   `compareExamplesWorstFirst`, so the shown sample leads with the most severe
   pages rather than an alphabetical slice. The comparator's lexicographic
   tiebreak makes the order — and thus the shown sample — the same every run.
3. **Example *retention* is worst-first and deterministic.**
   `ErrorAggregator.addError` keeps the **worst** examples (highest embedded
   metric, same comparator) once it hits `MAX_EXAMPLES_PER_ISSUE` (100), not the
   first-arriving or alphabetically-smallest ones — so even findings on >100
   pages retain the most severe sample (same memory bound). Metric-less bare-URL
   examples tie at `-Infinity` and fall back to the lexicographic tiebreak.

### What is *not* deterministic (by nature)

- **Live performance metrics** (TTFB, LCP, CLS, …) depend on the network and
  machine running the crawl. The *findings and ranking* derived from them are
  stable given the same measurements, but the raw numbers will differ.
- **Optional LLM passes** (the `--llm` flag: narrative, findings, repo, revalidation)
  are model-driven and not bit-reproducible. They are opt-in; the default
  template-driven report is deterministic. Results are disk-cached per audit so
  re-runs of the *same* audit are stable.
- **The live `--verify` pass** (default; `lib/phase3/live-verifier.ts`) re-fetches
  each finding's first example from the *live* site, so its verdicts reflect the
  site's current state at verification time, not the crawl-time snapshot — it is
  non-deterministic by design and timestamped in the report banner. It writes a
  SEPARATE `audit-report.verified.{md,pdf}` and never touches the deterministic
  main report. `SEO_AUDIT_VERIFY_OFFLINE=1` selects the legacy deterministic
  disk verifier instead.

Determinism is covered by tests in `tests/analyzers.test.ts`
(`buildReportMarkdown determinism`, `ErrorAggregator example retention
determinism`).
