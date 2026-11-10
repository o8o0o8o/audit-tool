# Website Technical Audit

## fixture.example

**Generated:** 2026-01-01  
**Pages:** 5 crawled (sitemap listed 5)  

## Purpose of the Audit

The primary purpose of this audit is to identify areas for improvement in the technical, SEO, performance, accessibility, and UX aspects of the website. It examines elements that impact user experience and search engine rankings, and proposes actionable recommendations to enhance the site's efficiency, compliance, and overall effectiveness.

## Scope of the Audit

To evaluate effectiveness from the perspective of both users and search engines, this audit covers:

- Performance (Core Web Vitals, asset optimization, caching, fonts, render-blocking resources)
- SEO (metadata, headings, structured data, sitemap, hreflang, internal links, status codes)
- GDPR & Privacy (consent banner, third-party trackers, cookie lifespan)
- Accessibility (axe-core findings + semantic heuristics)
- UX / UI (responsive layout, forms, navigation)
- Common technical issues (security headers, console errors, broken links)

## Methodology

The audit combines a deterministic crawl (Playwright on Chromium) with on-page analyzers and external signals (CrUX / PageSpeed Insights). All findings cited below are anchored in the crawl artifacts collected for this run.

Each category section header shows the current 0–100 score and, where there is room to improve, the score we would expect once that category’s issues are addressed across the site (`current → ~projected`). Because a category’s findings can appear in more than one section, the projection is shown once — on the section that owns the score — while individual findings everywhere carry the rough number of points fixing them recovers in their category (`+~N pts`). These projections are estimates — the `~` is deliberate: SEO and Technical scores are direct functions of the findings, while Performance, Accessibility and Security derive from measured per-page signals (Core Web Vitals, axe-core, security headers), so a per-finding figure approximates resolving the class of problem it represents.

**This run:**

- **Pages crawled:** 5
- **Sitemap entries:** 5
- **Representative-page evidence:** not captured (`--no-evidence` or no sampled pages)

## Summary and Recommendations

### Top Priority Issues

1. <span class="sev-high">CRITICAL</span> — Missing meta description *(2 occurrences)*
2. <span class="sev-high">HIGH</span> — Multiple H1 tags *(1 occurrence)*
3. <span class="sev-medium">MEDIUM</span> — Title too long *(3 occurrences)*

---

## SEO Audit

**Analysis.** No significant issues in this section — only 3 minor or informational notes, listed below.

**Minor & informational**

- Missing meta description *(2 pages)*
- Multiple H1 tags
- Title too long *(3 pages)*

## Performance Audit

**Analysis.** No significant issues in this section — only 1 minor or informational note, listed below.

**Minor & informational**

- Images without alt text *(4 pages)*
