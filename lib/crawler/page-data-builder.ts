/**
 * Page Data Builder
 * Handles page data processing: title, meta tags, link tags, redirects,
 * link collection, vitals validation, memory optimization, and snapshots
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PageInfo, SitemapUrl, Issue, HeadingAnalysis, UrlAnalysis } from '../types';
import type {
  CrawlResults,
  RedirectEntry,
  RequestInfo,
  LinkEntry,
  MetaTag,
  LinkTag,
  AlternateEntry,
  CollectLinksParams,
  ReportIssueFn,
  CrawlerInternalOptions,
  QueryParamConfig,
} from './crawler-types';
import {
  SEVERITY,
  THRESHOLDS,
  META_TAGS,
  META_TAGS_CONFIG,
  normalizeTextForComparison,
  CRAWL_SETTINGS,
} from '../constants';
import { normalizeUrl, createSafeFilename } from '../utils';
import { escapeHtml } from '../reports/html-utils';
import type { ChromePage } from '../types';

/**
 * Process title validation
 */
export function processTitle(
  title: string | null | undefined,
  url: string,
  uniqueTitles: Set<string>,
  reportIssue: ReportIssueFn,
): { title: string | null; titleLength: number } {
  const escapedUrl = escapeHtml(url);
  const maxTitleLength = CRAWL_SETTINGS.MAX_TITLE_LENGTH ?? 500;

  if (!title) {
    reportIssue(
      `Title is missing`,
      `Title is missing for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
      SEVERITY.CRITICAL,
    );
    return { title: null, titleLength: 0 };
  }

  // Truncate excessively long titles to prevent memory issues
  const originalLength = title.length;
  let processedTitle = title;
  if (originalLength > maxTitleLength) {
    processedTitle = title.substring(0, maxTitleLength) + '...';
  }

  const titleLength = originalLength;

  if (titleLength < THRESHOLDS.TITLE_MIN) {
    reportIssue(
      `Some pages have titles that are too short`,
      `The page <a href="${escapedUrl}">${escapedUrl}</a> has title length ${titleLength} chars (recommended: ${THRESHOLDS.TITLE_MIN}-${THRESHOLDS.TITLE_MAX})`,
      SEVERITY.MEDIUM,
    );
  } else if (titleLength > THRESHOLDS.TITLE_MAX) {
    reportIssue(
      `Some pages have titles that are too long`,
      `The page <a href="${escapedUrl}">${escapedUrl}</a> has title length ${titleLength} chars (recommended: ${THRESHOLDS.TITLE_MIN}-${THRESHOLDS.TITLE_MAX})`,
      SEVERITY.MEDIUM,
    );
  }

  // Normalize title for duplicate comparison (handles whitespace variations)
  const normalizedTitle = normalizeTextForComparison(title);
  if (uniqueTitles.has(normalizedTitle)) {
    reportIssue(
      `Some pages have identical titles`,
      `Title "${escapeHtml(title)}" is duplicated for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
      SEVERITY.HIGH,
    );
  }

  uniqueTitles.add(normalizedTitle);
  return { title: processedTitle, titleLength };
}

/**
 * Check for missing meta tags with appropriate severity levels
 */
function checkMissingMetaTags(pageData: PageInfo, url: string, reportIssue: ReportIssueFn): void {
  const escapedUrl = escapeHtml(url);
  const presentTags = new Set(Object.keys(pageData.metaMap ?? {}));

  // Check critical tags only - description
  // (Social tags are handled by SocialMediaAnalyzer to avoid duplicate errors)
  // (Viewport is handled by MobileFriendlyAnalyzer with detailed validation)
  for (const tag of META_TAGS_CONFIG.critical) {
    if (!presentTags.has(tag)) {
      if (tag === 'description' && !pageData.description) {
        reportIssue(
          `Description meta tag is missing`,
          `Meta description is missing for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
          SEVERITY.CRITICAL,
        );
      }
    }
  }

  // Track viewport presence for reference (detailed check in MobileFriendlyAnalyzer)
  pageData.hasViewport = presentTags.has('viewport');
}

/**
 * Process meta tags extraction and validation
 */
export function processMetaTags(
  metaTags: MetaTag[],
  pageData: PageInfo,
  url: string,
  uniqueDescriptions: Set<string>,
  reportIssue: ReportIssueFn,
): void {
  const escapedUrl = escapeHtml(url);

  // Store meta tags as both array (backwards compatible) and object (easier access)
  pageData.meta = [];
  pageData.metaMap = {};

  for (const metaTag of metaTags) {
    const name = metaTag.name;
    const content = metaTag.content;

    if (!name) continue;

    // Store in metaMap for easy access
    pageData.metaMap[name] = content;

    // Store in meta array for backwards compatibility
    if (META_TAGS.includes(name) || (META_TAGS_CONFIG.optional as readonly string[]).includes(name)) {
      pageData.meta.push({ [name]: content });
    }

    // Special handling for description
    if (name === 'description') {
      const maxDescLength = CRAWL_SETTINGS.MAX_DESCRIPTION_LENGTH ?? 1000;
      const descLength = content ? content.length : 0;
      // Truncate excessively long descriptions to prevent memory issues
      const processedContent =
        content && content.length > maxDescLength ? content.substring(0, maxDescLength) + '...' : content;
      pageData.description = processedContent;
      pageData.descriptionLength = descLength;

      if (descLength < THRESHOLDS.DESCRIPTION_MIN) {
        reportIssue(
          `Some pages have descriptions that are too short`,
          `The page <a href="${escapedUrl}">${escapedUrl}</a> has description length ${descLength} chars (recommended: ${THRESHOLDS.DESCRIPTION_MIN}-${THRESHOLDS.DESCRIPTION_MAX})`,
          SEVERITY.MEDIUM,
        );
      } else if (descLength > THRESHOLDS.DESCRIPTION_MAX) {
        reportIssue(
          `Some pages have descriptions that are too long`,
          `The page <a href="${escapedUrl}">${escapedUrl}</a> has description length ${descLength} chars (recommended: ${THRESHOLDS.DESCRIPTION_MIN}-${THRESHOLDS.DESCRIPTION_MAX})`,
          SEVERITY.MEDIUM,
        );
      }

      // Normalize description for duplicate comparison (handles whitespace variations)
      const normalizedDesc = normalizeTextForComparison(content);
      if (content && uniqueDescriptions.has(normalizedDesc)) {
        reportIssue(
          `Some pages have identical descriptions`,
          `Description "${escapeHtml(content.substring(0, 50))}..." is duplicated for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
          SEVERITY.HIGH,
        );
      }

      if (content) {
        uniqueDescriptions.add(normalizedDesc);
      }
    }

    // Check for deprecated keywords meta tag
    if (name === 'keywords' && content) {
      // Just note it in pageData, don't report as error (deprecated but not harmful)
      pageData.hasKeywords = true;
    }
  }

  // Check for missing critical and required meta tags
  checkMissingMetaTags(pageData, url, reportIssue);
}

/**
 * Check for duplicate alternates
 */
function checkAlternateDuplicates(alternates: AlternateEntry[], url: string, reportIssue: ReportIssueFn): void {
  const escapedUrl = escapeHtml(url);
  for (const alternate of alternates) {
    const count = alternates.reduce((acc, cur) => {
      if (cur.href === alternate.href) {
        return acc + 1;
      }
      return acc;
    }, 0);

    if (count > 1) {
      reportIssue(
        `Some alternates are duplicated in head links`,
        `Alternate ${escapeHtml(alternate.href)} is duplicated for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
        SEVERITY.MEDIUM,
      );
    }
  }
}

/**
 * Validate canonical matches sitemap
 */
function validateCanonicalMatchesSitemap(
  pageData: PageInfo,
  url: string,
  sitemapUrls: Record<string, SitemapUrl & { alternates?: Record<string, { hreflang: string }> }>,
  origin: string,
  reportIssue: ReportIssueFn,
): void {
  const escapedUrl = escapeHtml(url);
  const canonical = pageData.canonical ?? '';
  const normalizedCanonical = canonical.startsWith('http') ? canonical : new URL(canonical, origin).href;
  const escapedCanonical = escapeHtml(normalizedCanonical);
  const matchingCanonical = sitemapUrls[canonical] ?? sitemapUrls[normalizedCanonical];

  if (matchingCanonical) {
    if (matchingCanonical.alternates) {
      if (pageData.alternates) {
        for (const pageAlternate of pageData.alternates) {
          if (!matchingCanonical.alternates[pageAlternate.href]) {
            reportIssue(
              `Some alternates from sitemap don't match alternates from pages`,
              `Alternate ${escapeHtml(pageAlternate.href)} has no match in sitemap for loc ${escapedCanonical} for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
              SEVERITY.MEDIUM,
            );
          }
        }
      }

      if (Array.isArray(pageData.alternates)) {
        for (const pageAlternate of pageData.alternates) {
          const sitemapAlternate = matchingCanonical.alternates[pageAlternate.href];

          if (sitemapAlternate) {
            if (sitemapAlternate.hreflang !== pageAlternate.hreflang) {
              reportIssue(
                `Some alternate hreflangs from sitemap don't match alternate hreflangs from pages`,
                `Alternate hreflangs ${escapeHtml(pageAlternate.hreflang)} doesn't match sitemap hreflang ${escapeHtml(sitemapAlternate.hreflang)} for loc ${escapedCanonical} for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
                SEVERITY.MEDIUM,
              );
            }
          }
        }
      }
    }
  } else {
    reportIssue(
      `Some loc and canonical don't match`,
      `No matching loc corresponding canonical ${escapedCanonical} is found for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
      SEVERITY.HIGH,
    );
  }
}

/**
 * Process link tags (canonical, alternates)
 */
export function processLinkTags(
  linkTags: LinkTag[],
  pageData: PageInfo,
  url: string,
  sitemapUrls: Record<string, SitemapUrl & { alternates?: Record<string, { hreflang: string }> }>,
  origin: string,
  reportIssue: ReportIssueFn,
): { isMultiLang: boolean } {
  const escapedUrl = escapeHtml(url);
  let isMultiLang = false;

  for (const link of linkTags) {
    const rel = link.rel;

    if (rel === 'canonical') {
      pageData.canonical = link.href;
    }

    if (rel === 'alternate') {
      if (link.hrefLang && link.hrefLang !== 'x-default') {
        isMultiLang = true;
      }

      pageData.alternates ??= [];

      pageData.alternates.push({
        hreflang: link.hrefLang,
        href: link.href,
      });
    }
  }

  // Validate canonical
  if (!pageData.canonical) {
    reportIssue(
      `Canonicals are not set for some pages`,
      `Canonical link is missing for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
      SEVERITY.HIGH,
    );
  }

  // Validate alternates
  if (isMultiLang && !pageData.alternates) {
    reportIssue(
      `Alternates are not set for some pages`,
      `Alternates links are missing for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
      SEVERITY.MEDIUM,
    );
  } else if (pageData.alternates) {
    checkAlternateDuplicates(pageData.alternates, url, reportIssue);
  }

  // Validate canonical matches sitemap
  validateCanonicalMatchesSitemap(pageData, url, sitemapUrls, origin, reportIssue);

  return { isMultiLang };
}

/**
 * Process redirect chain
 */
export function processRedirects(
  pageData: PageInfo,
  redirectChain: RedirectEntry[],
  url: string,
  reportIssue: ReportIssueFn,
): void {
  pageData.redirectChain = redirectChain;
  pageData.hasRedirects = redirectChain.length > 0;
  // Chain includes final URL, so actual redirect count is length - 1
  pageData.redirectCount = Math.max(0, redirectChain.length - 1);

  if (redirectChain.length > 0) {
    const redirectCount = redirectChain.length - 1;
    const escapedUrl = escapeHtml(url);
    const escapedChain = redirectChain.map((r) => escapeHtml(r.url)).join(' → ');
    if (redirectCount > 2) {
      reportIssue(
        `Some pages have too many redirects`,
        `<a href="${escapedUrl}">${escapedUrl}</a> has ${redirectCount} redirect(s): ${escapedChain}`,
        SEVERITY.HIGH,
      );
    } else if (redirectCount > 0) {
      reportIssue(
        `Some pages have redirects`,
        `<a href="${escapedUrl}">${escapedUrl}</a> has ${redirectCount} redirect(s): ${escapedChain}`,
        SEVERITY.MEDIUM,
      );
    }
  }
}

/**
 * Collect links from page
 */
export function collectLinks(
  params: CollectLinksParams,
  origin: string,
  queryParams: QueryParamConfig,
  reportIssue: ReportIssueFn,
): { links: LinkEntry[]; httpLinksCount: number } {
  const {
    parsedPage,
    url,
    incomingLinksTracking,
    collectedURLs,
    uniquePages,
    pagesToCrawl,
    addMissing,
    discoveredLinksSource,
    sitemapUrls,
  } = params;

  const links: LinkEntry[] = [];
  let httpLinksCount = 0;

  for (const link of parsedPage.querySelectorAll('a')) {
    const href = link.attributes.href;
    const text = link.innerText || link.attributes['aria-label'];

    // Skip links without a valid href string (e.g. <a href> with no value)
    if (typeof href !== 'string' || !href) continue;

    // Skip pure anchor links
    if (href.startsWith('#')) {
      continue;
    }

    const isInternal = href?.startsWith(origin) || href?.startsWith('/');

    if (isInternal) {
      let fullHref = href;
      if (href?.startsWith('/')) {
        try {
          const baseUrl = new URL(url);
          fullHref = `${baseUrl.protocol}//${baseUrl.host}${href}`;
        } catch {
          continue;
        }
      }

      // Check HTTPS consistency
      if (origin.startsWith('https://') && fullHref?.startsWith('http://')) {
        httpLinksCount++;
      }

      // Normalize URL: strip hash, handle query params based on config
      const normalizedHref = normalizeUrl(fullHref, queryParams);

      // Track incoming links (store in Map, defer Array conversion to save time)
      if (!incomingLinksTracking.has(normalizedHref)) {
        incomingLinksTracking.set(normalizedHref, new Set());
      }
      incomingLinksTracking.get(normalizedHref)!.add(url);

      // Handle URL discovery with limit to prevent unbounded growth
      const maxDiscoveredUrls = CRAWL_SETTINGS.MAX_DISCOVERED_URLS ?? 100000;

      if (addMissing) {
        if (!collectedURLs.has(normalizedHref)) {
          // Check limit before adding new URLs
          if (pagesToCrawl.length < maxDiscoveredUrls) {
            pagesToCrawl.push(normalizedHref);
            collectedURLs.add(normalizedHref);
            uniquePages.add(normalizedHref);

            if (!sitemapUrls[normalizedHref]) {
              discoveredLinksSource.set(normalizedHref, url);
            }
          }
          // Silently skip URLs beyond the limit to prevent OOM
        }
      } else if (!uniquePages.has(normalizedHref)) {
        // Only track in collectedURLs if under limit
        if (collectedURLs.size < maxDiscoveredUrls) {
          collectedURLs.add(normalizedHref);

          if (!sitemapUrls[normalizedHref]) {
            discoveredLinksSource.set(normalizedHref, url);
          }
        }
      }
    }

    links.push({ text, href, isInternal });

    if (!text) {
      const escapedUrl = escapeHtml(url);
      const escapedHref = escapeHtml(href);
      reportIssue(
        `Some pages have links without any text`,
        `The page <a href="${escapedUrl}">${escapedUrl}</a> has a link without text "${escapedHref}"`,
        SEVERITY.MEDIUM,
      );
    }
  }

  // Report HTTPS consistency issues
  if (httpLinksCount > 0) {
    const escapedUrl = escapeHtml(url);
    reportIssue(
      `Some pages have HTTP links on HTTPS site`,
      `<a href="${escapedUrl}">${escapedUrl}</a> has ${httpLinksCount} internal HTTP link(s) (should use HTTPS)`,
      SEVERITY.HIGH,
    );
  }

  return { links, httpLinksCount };
}

/**
 * Check Core Web Vitals thresholds
 */
export function checkVitalsThresholds(
  pageData: PageInfo,
  url: string,
  TTFB: number,
  FCP: number,
  LCP: number,
  CLS: number,
  reportIssue: ReportIssueFn,
): void {
  const vitals = pageData.vitals ?? {};

  const escapedUrlForVitals = escapeHtml(url);

  if (TTFB > THRESHOLDS.TTFB) {
    reportIssue(
      `Some pages have TTFB more than ${THRESHOLDS.TTFB}ms`,
      `The page <a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> has TTFB ${Math.round(TTFB)}ms (threshold: ${THRESHOLDS.TTFB}ms)`,
      SEVERITY.HIGH,
    );
  }

  if (FCP > THRESHOLDS.FCP) {
    reportIssue(
      `Some pages have FCP more than ${THRESHOLDS.FCP}ms`,
      `The page <a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> has FCP ${Math.round(FCP)}ms (threshold: ${THRESHOLDS.FCP}ms)`,
      SEVERITY.HIGH,
    );
  }

  if (LCP > THRESHOLDS.LCP) {
    // Include LCP element attribution for debugging
    const lcpInfo = vitals.lcpElement
      ? ` (LCP element: ${escapeHtml(vitals.lcpElement)}${vitals.lcpUrl ? ', ' + escapeHtml(vitals.lcpUrl) : ''})`
      : '';
    reportIssue(
      `Some pages have LCP more than ${THRESHOLDS.LCP}ms`,
      `The page <a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> has LCP ${Math.round(LCP)}ms (threshold: ${THRESHOLDS.LCP}ms)${lcpInfo}`,
      SEVERITY.HIGH,
    );
  }

  if (CLS > THRESHOLDS.CLS) {
    // Include CLS shift count for debugging
    const clsInfo = vitals.clsShiftCount ? ` (${vitals.clsShiftCount} layout shifts)` : '';
    reportIssue(
      `Some pages have CLS more than ${THRESHOLDS.CLS}`,
      `The page <a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> has CLS ${CLS.toFixed(3)} (threshold: ${THRESHOLDS.CLS})${clsInfo}`,
      SEVERITY.HIGH,
    );
  }

  // INP check (only if measured - requires user interaction)
  const INP = pageData.INP;
  if (INP && INP > THRESHOLDS.INP) {
    const inpInfo = vitals.inpEvent ? ` (slowest interaction: ${escapeHtml(vitals.inpEvent)})` : '';
    reportIssue(
      `Some pages have INP more than ${THRESHOLDS.INP}ms`,
      `The page <a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> has INP ${Math.round(INP)}ms (threshold: ${THRESHOLDS.INP}ms)${inpInfo}`,
      SEVERITY.HIGH,
    );
  }

  // TBT check (Total Blocking Time)
  const TBT = pageData.TBT;
  if (TBT && TBT > THRESHOLDS.TBT) {
    const longTaskCount = (vitals.longTasks as unknown[] | undefined)?.length ?? 0;
    const tbtInfo = longTaskCount > 0 ? ` (${longTaskCount} long tasks detected)` : '';
    reportIssue(
      `Some pages have TBT more than ${THRESHOLDS.TBT}ms`,
      `The page <a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> has Total Blocking Time ${Math.round(TBT)}ms (threshold: ${THRESHOLDS.TBT}ms)${tbtInfo}`,
      TBT > 600 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
    );
  }

  // TTI check (Time to Interactive)
  const TTI = pageData.TTI;
  if (TTI && TTI > THRESHOLDS.TTI) {
    reportIssue(
      `Some pages have TTI more than ${THRESHOLDS.TTI}ms`,
      `The page <a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> has Time to Interactive ${Math.round(TTI)}ms (threshold: ${THRESHOLDS.TTI}ms)`,
      TTI > 7300 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
    );
  }

  // LCP sub-parts analysis for failed LCP
  if (LCP > THRESHOLDS.LCP && vitals.lcpAnalysis) {
    const { bottleneck, percentages, recommendations, recommendation } = vitals.lcpAnalysis as Record<string, unknown>;
    if (bottleneck && bottleneck !== 'none') {
      const bottleneckNames: Record<string, string> = {
        ttfb: 'Server Response (TTFB)',
        resourceDelay: 'Resource Discovery Delay',
        resourceLoad: 'Resource Load Time',
        renderDelay: 'Render Delay',
      };
      const rec = (recommendation ?? (recommendations as string[] | undefined)?.[0] ?? '') as string;
      // percentages may be undefined if memory optimization already ran
      const pct = percentages as Record<string, number> | undefined;
      const breakdown = pct
        ? `LCP breakdown: TTFB ${pct.ttfb}%, Resource Delay ${pct.resourceDelay}%, Load ${pct.resourceLoad}%, Render ${pct.renderDelay}%. `
        : '';
      reportIssue(
        `LCP bottleneck: ${bottleneckNames[bottleneck as string] || bottleneck}`,
        `<a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> ${breakdown}${escapeHtml(rec)}`,
        SEVERITY.MEDIUM,
      );
    }
  }
}

/**
 * Optimize page data memory footprint after all processing is complete
 * Converts detailed arrays to summaries while preserving all issues/warnings for the report
 */
export function optimizePageDataMemory(pageData: PageInfo): void {
  // PageInfo has [key: string]: any index signature, allowing dynamic property access
  // Analyzer results often have more fields than the strict type definitions

  // 1. Strip raw schema data (can be huge for e-commerce Product schemas)
  const sd = pageData.structuredData as Record<string, unknown> | undefined;
  if (sd?.jsonLdSchemas) {
    for (const schema of sd.jsonLdSchemas as Array<Record<string, unknown>>) {
      delete schema.raw;
    }
  }

  // 2. Reduce requests object to summary (keeps type breakdown for report)
  if (pageData.requests && typeof pageData.requests === 'object' && !pageData.requests.totalRequests) {
    const entries = Object.entries(pageData.requests) as Array<[string, RequestInfo]>;
    const byType: Record<string, number> = {};
    let totalSize = 0;
    for (const [, req] of entries) {
      byType[req.resourceType ?? 'other'] = (byType[req.resourceType ?? 'other'] ?? 0) + 1;
      if (req.size) totalSize += req.size;
    }
    pageData.requests = { totalRequests: entries.length, byType, totalSize };
  }

  // 3. Keep only problematic links (links without text)
  if (Array.isArray(pageData.links)) {
    pageData.linksCount = pageData.links.length;
    pageData.internalLinksCount = pageData.links.filter((l: LinkEntry) => l.isInternal).length;
    pageData.externalLinksCount = pageData.links.filter((l: LinkEntry) => !l.isInternal).length;
    pageData.links = pageData.links.filter((l: LinkEntry) => !l.text || l.text.trim() === '').slice(0, 20);
  }

  // 4. Reduce images array (keep problematic ones)
  const imagesArr = pageData.images as unknown;
  if (Array.isArray(imagesArr)) {
    pageData.imagesCount = imagesArr.length;
    pageData.imagesWithoutAltCount = imagesArr.filter((i: { alt?: string }) => !i.alt || i.alt.trim() === '').length;
    (pageData as Record<string, unknown>).images = imagesArr
      .filter((i: { alt?: string }) => !i.alt || i.alt.trim() === '')
      .slice(0, 10);
  }

  // 5. Strip vitals detail arrays (keep analysis summaries)
  if (pageData.vitals) {
    delete pageData.vitals.lcpSubParts;
    delete pageData.vitals.clsEntries;
    delete pageData.vitals.longTasks;
    if (pageData.vitals.lcpAnalysis) {
      pageData.vitals.lcpAnalysis = {
        bottleneck: (pageData.vitals.lcpAnalysis as Record<string, unknown>).bottleneck,
        recommendation: (pageData.vitals.lcpAnalysis as Record<string, unknown>).recommendation,
      };
    }
  }

  // 6. Delete heavy objects not needed for report
  delete pageData.metrics;
  delete pageData.blockers;

  // 7. Strip linkAnalysis (keep counts, issues, and fields needed by site-wide LinkStructureAnalyzer)
  if (pageData.linkAnalysis) {
    pageData.linkAnalysis = {
      internalLinks: pageData.linkAnalysis.internalLinks ?? 0,
      externalLinks: pageData.linkAnalysis.externalLinks ?? 0,
      brokenLinks: pageData.linkAnalysis.brokenLinks ?? 0,
      anchorTextMap: pageData.linkAnalysis.anchorTextMap,
      externalDomains: pageData.linkAnalysis.externalDomains,
      genericAnchorLinks: pageData.linkAnalysis.genericAnchorLinks,
      internalNofollowLinks: pageData.linkAnalysis.internalNofollowLinks,
      issues: pageData.linkAnalysis.issues,
      warnings: pageData.linkAnalysis.warnings,
    };
  }

  // 8. Strip contentQuality (keep scores and top keywords)
  if (pageData.contentQuality) {
    const cq = pageData.contentQuality as unknown as Record<string, unknown>;
    delete cq.keywords;
    if (Array.isArray(cq.topKeywords)) {
      cq.topKeywords = (cq.topKeywords as unknown[]).slice(0, 5);
    }
  }

  // 9. Strip third-party data (keep summary)
  if (pageData.thirdPartyData?.scripts) {
    pageData.thirdPartyData = {
      totalScripts: pageData.thirdPartyData.scripts.length,
      totalSize: pageData.thirdPartyData.totalSize ?? 0,
      issues: pageData.thirdPartyData.issues,
      warnings: pageData.thirdPartyData.warnings,
    };
  }

  // 10. Strip timing data (keep slow resources sample)
  if (pageData.timingData?.resourceTimings) {
    pageData.timingData = {
      slowResources: (pageData.timingData.slowResources ?? []).slice(0, 5),
      issues: pageData.timingData.issues,
      warnings: pageData.timingData.warnings,
    };
  }

  // 11. Strip critical path data (keep counts)
  if (pageData.criticalPathData?.blockingCSS) {
    pageData.criticalPathData = {
      blockingCSSCount: pageData.criticalPathData.blockingCSS?.length ?? 0,
      blockingJSCount: pageData.criticalPathData.blockingJS?.length ?? 0,
      issues: pageData.criticalPathData.issues,
      warnings: pageData.criticalPathData.warnings,
    };
  }

  // 12. Strip font data (keep count)
  if (pageData.fontData?.fonts) {
    pageData.fontData = {
      totalFonts: (pageData.fontData.fonts as unknown[]).length,
      issues: pageData.fontData.issues,
      warnings: pageData.fontData.warnings,
    };
  }

  // 13. Strip compression data
  if (pageData.compressionData?.resources) {
    pageData.compressionData = {
      issues: pageData.compressionData.issues,
      warnings: pageData.compressionData.warnings,
    };
  }

  // 14. Strip image optimization data (keep counts needed by report)
  if (pageData.imageOptimization?.images) {
    const imgOpt = pageData.imageOptimization;
    pageData.imageOptimization = {
      totalImages: imgOpt.images!.length,
      withLazyLoading: imgOpt.withLazyLoading ?? 0,
      modernFormats: imgOpt.modernFormats ?? 0,
      legacyFormats: imgOpt.legacyFormats ?? 0,
      totalImageSize: imgOpt.totalImageSize ?? 0,
      issues: imgOpt.issues,
      warnings: imgOpt.warnings,
    };
  }

  // 15. Strip console analysis (keep count)
  if (pageData.consoleAnalysis?.errors) {
    pageData.consoleAnalysis = {
      errorCount: pageData.consoleAnalysis.errors?.length ?? 0,
      warningCount: pageData.consoleAnalysis.warnings?.length ?? 0,
      issues: pageData.consoleAnalysis.issues,
    };
  }

  // 16. Strip form data (keep count and accessibility score)
  if (pageData.formData?.forms) {
    pageData.formData = {
      formCount: pageData.formData.forms.length,
      accessibilityScore: pageData.formData.accessibilityScore,
      totalInputs: pageData.formData.totalInputs ?? 0,
      inputsWithoutLabels: pageData.formData.inputsWithoutLabels ?? 0,
      inputsWithoutAutocomplete: pageData.formData.inputsWithoutAutocomplete ?? 0,
      issues: pageData.formData.issues,
      warnings: pageData.formData.warnings,
    };
  }

  // 17. Strip resource optimization (keep counts needed by report)
  if (pageData.resourceOptimization?.renderBlockingResources) {
    const resOpt = pageData.resourceOptimization;
    pageData.resourceOptimization = {
      renderBlockingCount: resOpt.renderBlockingResources?.length ?? 0,
      renderBlocking: {
        totalBlocking: resOpt.renderBlocking?.totalBlocking ?? resOpt.renderBlockingResources?.length ?? 0,
      },
      compression: { uncompressed: resOpt.compression?.uncompressed ?? 0 },
      minification: {
        unminifiedJS: resOpt.minification?.unminifiedJS ?? 0,
        unminifiedCSS: resOpt.minification?.unminifiedCSS ?? 0,
      },
      issues: resOpt.issues,
      warnings: resOpt.warnings,
    };
  }

  // 18. Strip headings (keep counts for all levels and first h1)
  const hdg = pageData.headings as Record<string, unknown> | undefined;
  if (hdg?.h1 && Array.isArray(hdg.h1)) {
    const h1Arr = hdg.h1 as string[];
    const h2Arr = hdg.h2 as string[] | undefined;
    const h3Arr = hdg.h3 as string[] | undefined;
    const h4Arr = hdg.h4 as string[] | undefined;
    const h5Arr = hdg.h5 as string[] | undefined;
    const h6Arr = hdg.h6 as string[] | undefined;
    pageData.headings = {
      h1Count: h1Arr.length,
      h2Count: h2Arr?.length ?? 0,
      h3Count: h3Arr?.length ?? 0,
      h4Count: h4Arr?.length ?? 0,
      h5Count: h5Arr?.length ?? 0,
      h6Count: h6Arr?.length ?? 0,
      h1: h1Arr.map((h: string) => (typeof h === 'string' ? h.substring(0, 100) : h)),
      issues: hdg.issues,
      warnings: hdg.warnings,
    } as unknown as HeadingAnalysis;
  }

  // 19. Strip accessibility data (keep scores and summary counts for report)
  if (pageData.accessibility?.aria || pageData.accessibility?.violations) {
    const a11y = pageData.accessibility;
    pageData.accessibility = {
      violationCount: a11y.violations?.length ?? 0,
      a11yScore: a11y.a11yScore ?? null,
      aria: a11y.aria
        ? {
            valid: a11y.aria.valid ?? 0,
            invalid: a11y.aria.invalid ?? 0,
          }
        : null,
      forms: a11y.forms
        ? {
            inputsWithLabels: a11y.forms.inputsWithLabels ?? 0,
            inputsWithoutLabels: a11y.forms.inputsWithoutLabels ?? 0,
          }
        : null,
      semantic: a11y.semantic
        ? {
            hasMain: a11y.semantic.hasMain ?? false,
            hasNav: a11y.semantic.hasNav ?? false,
            hasHeader: a11y.semantic.hasHeader ?? false,
            hasFooter: a11y.semantic.hasFooter ?? false,
          }
        : null,
      keyboard: a11y.keyboard
        ? {
            elementsWithoutFocus: a11y.keyboard.elementsWithoutFocus ?? 0,
            positiveTabindex: a11y.keyboard.positiveTabindex ?? 0,
          }
        : null,
      issues: a11y.issues,
      warnings: a11y.warnings,
    };
  }

  // 20. Strip caching data (keep scores and counts for report)
  if (pageData.caching?.resources || pageData.caching?.cacheScore != null) {
    const cache = pageData.caching;
    pageData.caching = {
      cacheScore: cache.cacheScore ?? null,
      hasCDN: cache.hasCDN ?? false,
      cdnProvider: cache.cdnProvider ?? null,
      staticCached: cache.staticCached ?? 0,
      staticUncached: cache.staticUncached ?? 0,
      dynamicCached: cache.dynamicCached ?? 0,
      dynamicUncached: cache.dynamicUncached ?? 0,
      hasServiceWorker: cache.hasServiceWorker ?? false,
      cachedCount: cache.cachedCount ?? 0,
      uncachedCount: cache.uncachedCount ?? 0,
      issues: cache.issues,
      warnings: cache.warnings,
    };
  }

  // 21. Strip media data (keep counts)
  if (pageData.mediaData?.videos || pageData.mediaData?.audios) {
    pageData.mediaData = {
      videoCount: pageData.mediaData.videos?.length ?? 0,
      audioCount: pageData.mediaData.audios?.length ?? 0,
      issues: pageData.mediaData.issues,
      warnings: pageData.mediaData.warnings,
    } as unknown as typeof pageData.mediaData;
  }

  // 22. Strip web component data
  if (pageData.webComponentData?.components) {
    pageData.webComponentData = {
      componentCount: pageData.webComponentData.components?.length ?? 0,
      issues: pageData.webComponentData.issues,
      warnings: pageData.webComponentData.warnings,
    };
  }

  // 23. Strip above-fold data (keep key metrics)
  if (pageData.aboveFoldData?.aboveFoldElements) {
    pageData.aboveFoldData = {
      lcpInViewport: pageData.aboveFoldData.lcpInViewport,
      renderBlockingResources: pageData.aboveFoldData.renderBlockingResources,
      aboveFoldImageSize: pageData.aboveFoldData.aboveFoldImageSize,
      issues: pageData.aboveFoldData.issues,
      warnings: pageData.aboveFoldData.warnings,
    };
  }

  // 24. Strip anchor text data
  if (pageData.anchorTextData?.anchors) {
    pageData.anchorTextData = {
      anchorCount: pageData.anchorTextData.anchors?.length ?? 0,
      issues: pageData.anchorTextData.issues,
      warnings: pageData.anchorTextData.warnings,
    };
  }

  // 25. Strip external links data
  if (pageData.externalLinksData?.links) {
    pageData.externalLinksData = {
      externalLinkCount: pageData.externalLinksData.links?.length ?? 0,
      issues: pageData.externalLinksData.issues,
      warnings: pageData.externalLinksData.warnings,
    };
  }

  // 26. Strip meta array (metaMap is more useful and smaller)
  if (Array.isArray(pageData.meta) && pageData.metaMap) {
    delete pageData.meta;
  }

  // 27. Strip URL analysis (keep issues only)
  const urlA = pageData.urlAnalysis as Record<string, unknown> | undefined;
  if (urlA?.components) {
    pageData.urlAnalysis = {
      depth: urlA.depth as number,
      length: urlA.length as number,
      hasParameters: urlA.hasParameters as boolean,
      issues: urlA.issues as Issue[],
    } as unknown as UrlAnalysis;
  }

  // 28. Strip response object (headers are large and rarely needed after analysis)
  if (pageData.response?.headers) {
    delete pageData.response;
  }
  delete pageData.responseHeaders;

  // 29. Strip redirect chain (keep URLs for tooltip, limit to 10)
  const rc = pageData.redirectChain;
  if (rc && Array.isArray(rc) && rc.length > 0) {
    pageData.redirectCount = rc.length;
    pageData.redirectChain = rc.slice(0, 10).map((r: RedirectEntry) => ({ url: r.url, status: r.status }));
  }

  // 30. Limit issues/warnings arrays on all analyzers to 20 each
  const limitArrays = (obj: Record<string, unknown>) => {
    if (obj?.issues && Array.isArray(obj.issues)) {
      obj.issues = obj.issues.slice(0, 20);
    }
    if (obj?.warnings && Array.isArray(obj.warnings)) {
      obj.warnings = obj.warnings.slice(0, 20);
    }
  };

  // Apply limits to all analyzer outputs
  [
    'linkAnalysis',
    'accessibility',
    'caching',
    'contentQuality',
    'imageOptimization',
    'resourceOptimization',
    'structuredData',
    'headings',
    'internationalSEO',
    'thirdPartyData',
    'timingData',
    'criticalPathData',
    'fontData',
    'compressionData',
    'consoleAnalysis',
    'formData',
    'mediaData',
    'webComponentData',
    'aboveFoldData',
    'anchorTextData',
    'externalLinksData',
    'security',
  ].forEach((key) => {
    if (pageData[key]) {
      limitArrays(pageData[key]);
    }
  });
}

/**
 * Save HTML snapshot
 */
export function saveHtmlSnapshot(pageContent: string, url: string, options: CrawlerInternalOptions): void {
  if (!options.saveHtml) {
    return;
  }

  const folderName = `audit_${createSafeFilename(options.origin)}`;
  const folder = path.join(process.cwd(), folderName);

  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (error: unknown) {
    console.error(`Failed to create directory ${folder}:`, (error as Error).message);
    return;
  }

  const safeFilename = createSafeFilename(url);
  const filePath = path.join(folder, `${safeFilename}.html`);

  try {
    fs.writeFileSync(filePath, pageContent);
  } catch (error: unknown) {
    console.error(`Failed to write file ${filePath}:`, (error as Error).message);
  }
}

/**
 * Save viewport screenshot
 */
export async function saveScreenshot(
  chromePage: ChromePage,
  url: string,
  options: CrawlerInternalOptions,
): Promise<void> {
  if (!options.screenshots) {
    return;
  }

  const folderName = `audit_${createSafeFilename(options.origin)}`;
  const folder = path.join(process.cwd(), folderName, 'screenshots');

  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (error: unknown) {
    console.error(`Failed to create screenshots directory ${folder}:`, (error as Error).message);
    return;
  }

  const safeFilename = createSafeFilename(url);
  const filePath = path.join(folder, `${safeFilename}.png`);

  try {
    await chromePage.screenshot({ path: filePath, fullPage: false });
  } catch (error: unknown) {
    // Screenshot failures are non-critical
    if (options.verbose) {
      console.error(`Failed to capture screenshot for ${url}:`, (error as Error).message);
    }
  }
}

/**
 * Populate incoming links count for each page
 */
export function populateIncomingLinksCount(results: CrawlResults): void {
  for (const url in results.pageData.pages) {
    const incomingLinksArray = results.pageData.incomingLinks?.[url] ?? [];
    const incomingLinksCount = Array.isArray(incomingLinksArray) ? incomingLinksArray.length : 0;
    results.pageData.pages[url].incomingLinksCount = incomingLinksCount;
    results.pageData.pages[url].hasIncomingLinks = incomingLinksCount > 0;
  }
}
