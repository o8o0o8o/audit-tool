# Audit presets

`--preset=<name>` (or `"preset"` in `.seoauditrc`, or the web form's preset selector) picks an audit type. The source of truth is `lib/presets.ts` (`resolvePreset`). An unknown name is rejected with an error that lists the valid presets.

There are two kinds of preset:

- **Speed presets** (`quick`, `standard`, `deep`) change only how the crawl runs. The report is complete.
- **Role presets** (`sales`, `marketing`, `seo`, `custom`) also choose **which report sections are rendered, and in what order**. Some also keep only certain **finding groups** (checks). Every analyzer still runs during the crawl, so the raw data is always complete. The preset only shapes what the Phase 2 report (`audit-report.{md,html,pdf}`), the HTML report and the Phase 3 verified report show. The selection is saved in `phase2-state.json`, so a re-verify renders the same view.

An explicit `--concurrency` or `--limit` always overrides the preset's value.

## Speed presets

| Preset     | Run options                                       | Why                                                   |
| ---------- | ------------------------------------------------- | ----------------------------------------------------- |
| `quick`    | 50 pages max, no perf metrics, concurrency 10     | Fast sanity check                                     |
| `standard` | defaults                                          | Normal audit                                          |
| `deep`     | all pages, `--perf`, `--save-html`, concurrency 3 | Thorough audit with accurate metrics and HTML snapshots |

## Role presets

The role mapping comes from research into what each audience uses an audit for (prospecting/sales-audit guides, marketing-audit and conversion-audit checklists). That research was directional, so the presets are a starting point. Use `custom` for anything else.

### `sales` (BDM / sales)

- **Sections, in order:** executive summary → technology stack → CTAs/conversion → top issues → performance → UX.
- **Checks:** performance, seo, ux, cta, technology.
- **Run options:** none — your own flags (`--perf`, `--limit`, …) apply.
- **Why:** A prospecting audit has to be short and scored, and it has to lead with gaps the agency can sell. The executive summary and score open the conversation. The technology stack shows what the prospect runs. CTAs and conversion tie problems to lost business. Top issues and Core Web Vitals headline numbers give concrete, easy-to-explain pain points. A 50-page cap keeps the run fast enough to use before a call. Accessibility, privacy and deep technical detail are left out because they don't help the pitch.

### `marketing`

- **Sections, in order:** executive summary → top issues → SEO → content insights → CTAs/conversion → UX → performance → privacy.
- **Checks:** seo, content, ux, cta, performance, privacy, analytics, `visual`.
- **Run options:** none — your own flags (`--perf`, `--limit`, …) apply.
- **Why:** Marketers own traffic and conversion. They need conversion tracking (GA4/GTM, forms, phone/mail clicks), CTA placement, social/Open Graph tags, content quality and freshness, and consent/privacy, because tracking without consent is a marketing liability. SEO is included at the level that affects visibility. Low-level technical, accessibility and source-code findings are dropped.

### `seo` (SEO specialist)

- **Sections, in order:** executive summary → top issues → SEO → technical → performance → accessibility → content insights → charts → pages table.
- **Checks:** all (no finding filter), so `visual` (broken images/media, upscaled images, template tokens, mojibake, clipped text) is included.
- **Run options:** none — your own flags (`--perf`, `--limit`, …) apply.
- **Why:** An SEO specialist needs the full technical depth: indexability, canonicals, hreflang, sitemaps, crawl budget, Core Web Vitals, and the per-page table to work through. SEO and technical findings come first. Add `--verify` and `--evidence` for a fully fact-checked report.

### `custom`

You build the view yourself. Pass `--sections=<csv>` and/or `--checks=<csv>`. At least one is required, and both are only accepted with `--preset=custom`. Sections render **in the order you list them**.

Valid sections (`REPORT_SECTIONS`):
`executive-summary`, `technology-stack`, `cta`, `top-issues`, `performance`, `seo`, `privacy`, `accessibility`, `ux`, `technical`, `charts`, `content-insights`, `pages`, `source-code`, `history`.

Valid checks (`CHECK_NAMES`):
`performance`, `seo`, `accessibility`, `security`, `privacy`, `ux`, `technical`, `content`, `cta`, `technology`, `analytics`, `visual`.

`visual` covers broken images and failed image/media requests, images and CSS backgrounds upscaled beyond their natural resolution, unrendered template tokens, lorem ipsum, mojibake and clipped text. It is in the `marketing` and `seo` presets, not in `sales`.

A finding belongs to its report section's group plus every group whose keywords match its message (`findingCheckGroups`). For example, a missing-GA4 finding in UX also belongs to `analytics`. A finding is kept when any of its groups is selected.

```bash
# Developer-style view: performance, technical and security only, with source code
npx tsx start.ts --origin=https://example.com --perf --repo=../site \
  --preset=custom --sections=executive-summary,performance,technical,source-code \
  --checks=performance,technical,security
```

Or in `.seoauditrc`:

```json
{
  "preset": "custom",
  "sections": ["executive-summary", "top-issues", "seo", "pages"],
  "checks": ["seo", "content"]
}
```

On the CLI, `--preset` wins over the config file. Unknown section or check names are rejected with the list of valid values.

## Adding a built-in preset

Add the name to `ROLE_PRESETS`, add its definition (sections, optional checks, run options) to `ROLE_DEFINITIONS`, and add a one-line summary to `PRESET_SUMMARIES` in `lib/presets.ts`. Then update `completions.sh`, the web options (`web/lib/audit-options.ts`), this doc, and `tests/presets.test.ts`.
