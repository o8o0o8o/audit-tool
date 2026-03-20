# Plan: Fix All Code Quality Issues

**Created:** 2026-03-19
**Status:** COMPLETE

## Context

Comprehensive code quality audit identified 7 categories of issues across the SEO audit tool codebase. Current state: ESLint and TypeScript pass clean, but 11 files fail Prettier formatting, and deeper code quality issues exist in type safety, error handling, magic numbers, and function complexity.

## Tasks

- [x] 1. Fix Prettier formatting (11 files)
  - Files: `generateCSV.ts`, `historyManager.ts`, `lib/analyzers/performance/above-fold-analyzer.ts`, `lib/analyzers/performance/compression-analyzer.ts`, `lib/analyzers/performance/pwa-analyzer.ts`, `lib/crawler/analyzer-runner.ts`, `lib/orchestrators/progress-manager.ts`, `lib/reports/sections/executive-summary.ts`, `lib/reports/sections/pages-table.ts`, `lib/seo-data.ts`, `lib/utils/cli-summary.ts`
  - Details: Run `npx prettier --write` on all 11 non-compliant files. Zero-risk automated fix.

- [x] 2. Centralize magic numbers from `resilience.ts` to `constants.ts`
  - Files: `lib/crawler/resilience.ts`, `lib/constants.ts`
  - Details: `CIRCUIT_THRESHOLD` (10) and `CIRCUIT_COOLDOWN` (60000) are already exported from resilience.ts but should be moved to the centralized constants file. Also move the backoff reset timeout (300000ms), base delay (1000ms), and max delay (30000ms) into CRAWL_SETTINGS.

- [x] 3. Centralize magic numbers from `score-calculator.ts` to `constants.ts`
  - Files: `lib/scoring/score-calculator.ts`, `lib/constants.ts`
  - Details: Move category weights (seo: 0.3, performance: 0.25, etc.), severity weights (critical: 5, high: 3, etc.), impact severity weights (100, 70, 40, 20), log penalty scales (8, 9), breadth multiplier max (5) and factor (4), default category scores (accessibility: 70, security: 70), and quick win thresholds (impactScore >= 40, effortMinutes <= 30) to constants.

- [x] 4. Fix `calculateSummary` type safety in `score-calculator.ts`
  - Files: `lib/scoring/score-calculator.ts`
  - Details: The `summary` object is typed as `Record<string, unknown>` causing casts like `(summary.criticalCount as number)`. Replace with a properly typed interface with `totalIssues: number`, `criticalCount: number`, etc. This eliminates 5+ type assertions.

<!-- COMMIT CHECKPOINT -->

- [x] 5. Add logging to empty catch blocks in `robots.ts`
  - Files: `robots.ts`
  - Details: Lines 396-397, 422-423, 501-502, 509-510 have empty catch blocks with only comments. Add `console.debug(...)` calls so failures are traceable in verbose mode. These are for optional features (history, badge, notification, audit log).

- [x] 6. Add logging to empty catch blocks in `data-processor.ts`
  - Files: `lib/reports/data-processor.ts`
  - Details: Lines 79 and 136 have silent catch blocks for incoming links and repo analysis loading. Add `console.debug(...)` to make failures traceable.

- [x] 7. Fix non-null assertions in `seo-data.ts`
  - Files: `lib/seo-data.ts`
  - Details: Lines 35-36 (`#progressManager!`, `#crawlerEngine!`) and lines 49-51 (`fileManager!`, `resultsDir!`, `file!`) use definite assignment assertions. Refactor to use `| undefined` types and add runtime checks, or initialize with a sentinel value in the constructor and use a lazy initialization pattern with getter methods that throw if not initialized.

- [x] 8. Fix non-null assertions in `freshness-analyzer.ts` and `page-data-builder.ts`
  - Files: `lib/analyzers/content/freshness-analyzer.ts`, `lib/crawler/page-data-builder.ts`
  - Details: `getAttribute('content')!` assertions on lines 85 and 96 of both files. The `metaPublished`/`metaModified` elements are checked for existence, but `getAttribute()` can return null. Add null coalescing: `getAttribute('content') ?? ''` with an early continue if empty.

<!-- COMMIT CHECKPOINT -->

- [x] 9. Fix type assertions in `html-utils.ts`
  - Files: `lib/reports/html-utils.ts`
  - Details: Line 85 `(page.meta as Record<string, unknown>[])` - the `hasMetaTag` function casts meta array. Update the function signature or add a type guard. Line 199 `(colors as Record<string, SeverityColorConfig>)` - use a properly typed constant with an index signature or a Map.

- [x] 10. Fix type assertions in `pages-table.ts`
  - Files: `lib/reports/sections/pages-table.ts`
  - Details: Lines 822 and 1054 use `{} as AccessibilityAnalysis`, lines 911 and 1067 use `{} as ContentQualityAnalysis`. Create proper default objects or use `Partial<T>` type with optional chaining throughout. Lines 977 and 1086 cast `wcs as Record<string, number>` - add proper type narrowing.

- [x] 11. Fix type assertions in `resilience.ts` `handlePageError`
  - Files: `lib/crawler/resilience.ts`
  - Details: Lines 227-228 and 236-237 cast `byError` values with `as string[]` and `as number`. The `byError` record mixes arrays and numbers (e.g., `byError['timeout']` is `string[]` but `byError['total_timeout']` is `number`). Type `byError` properly using a discriminated structure or separate maps for URLs vs counts.

<!-- COMMIT CHECKPOINT -->

- [x] 12. Simplify `#detectMultilanguage` in `audit-orchestrator.ts`
  - Files: `lib/orchestrators/audit-orchestrator.ts`
  - Details: Lines 219-265 check `if (!isMultiLang)` three times in sequence. Since `isMultiLang` starts as `false`, these are redundant guards. Refactor to use early returns: check sitemaps, if found return true; check pages, if found return true; check URL patterns, return result.

- [x] 13. Improve `content-quality-analyzer.ts` readability constant documentation
  - Files: `lib/analyzers/content/content-quality-analyzer.ts`
  - Details: Lines 53-54 have Flesch Reading Ease formula with magic numbers (206.835, 1.015, 84.6). These are well-known constants from the Flesch formula and should NOT be moved to constants.ts, but add a comment with the formula name and reference. Also, line 270 uses hardcoded readability thresholds (30, 50) and line 278 uses hardcoded sentence length (25) - add named constants for these within the evaluate callback.

- [x] 14. Add content scoring constants to `thin-content-analyzer.ts`
  - Files: `lib/analyzers/content/thin-content-analyzer.ts`
  - Details: Lines 129-153 have hardcoded scoring values (50, 35, 20, 5 for word count; 25, 20, 10 for text ratio; 25, 15, 10 for structure). Extract these into a static SCORING config object on the class for clarity and maintainability.

<!-- COMMIT CHECKPOINT -->

- [x] 15. Run lint, typecheck, and tests to verify all changes
  - Files: (all modified files)
  - Details: Run `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm test` to ensure nothing is broken.

## Notes

- Tasks 2-4 (magic numbers + type safety in score-calculator) are tightly coupled and should be done together.
- Tasks 9-11 (type assertions) may require changes to `lib/types.ts` if the interfaces need updating.
- The long function decomposition issue (crawler-engine.ts 390-line crawlPages, 275-line processPageData) was NOT included as a task because: (a) these functions were already decomposed from a single mega-function in a previous refactor, (b) further splitting would fragment the flow logic without meaningful benefit, (c) the risk of introducing bugs during decomposition is high relative to the readability gain.
- Analyzer pattern consistency (inconsistent method naming across 30+ analyzers) was NOT included because: renaming would be high churn with low value since the analyzers are called through a registry pattern where names don't need to match.
