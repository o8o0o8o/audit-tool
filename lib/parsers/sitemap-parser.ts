/**
 * Sitemap Parser
 * Fetches and parses XML sitemaps according to the sitemap protocol
 */

import { parse, HTMLElement } from 'node-html-parser';
import { SEVERITY, THRESHOLDS } from '../constants';
import type { SitemapUrl } from '../types';

interface SitemapEntry {
  total: number;
  totalUnique: number;
  urls: Record<string, SitemapParsedUrl>;
}

/** Extends SitemapUrl with alternates stored as a record (keyed by href) during parsing */
interface SitemapParsedUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: string;
  alternates?: Record<string, { hreflang: string; href: string }>;
}

/** Combined result type for the sitemap parser */
interface SitemapParserResult {
  sitemaps: Record<string, SitemapEntry>;
  urls: Record<string, SitemapParsedUrl>;
  total: number;
  errors: Array<{ message: string; detail: string; severity: string }>;
}

class SitemapParser {
  /**
   * Fetch and parse sitemaps from given URLs
   * @param {string} origin - Website origin URL
   * @param {string[]} sitemapUrls - Array of sitemap URLs from robots.txt
   * @returns {Promise<object>} Parsed sitemap data and any errors found
   */
  static async parseSitemaps(origin: string, sitemapUrls: string[]) {
    const result: SitemapParserResult = {
      sitemaps: {}, // Per-sitemap data
      urls: {}, // All URLs combined
      total: 0, // Total URL count
      errors: [], // Array of { message, detail, severity }
    };

    console.log("Analyzing sitemaps...");

    for (const sitemapUrl of sitemapUrls) {
      try {
        console.log(`Fetching sitemap: ${sitemapUrl}`);

        // Fetch with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), THRESHOLDS.FETCH_TIMEOUT);

        const sitemapResponse = await fetch(sitemapUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        const sitemap = await sitemapResponse.text();
        const parsedSitemap = parse(sitemap);
        const urls = parsedSitemap.querySelectorAll("url");

        if (urls.length) {
          // Regular sitemap with URLs
          console.log(`Processing ${urls.length} URLs from sitemap`);
          this.processSitemap(urls, origin, sitemapUrl, result);
        } else {
          // Sitemap index file - process each nested sitemap independently
          const nestedSitemaps = parsedSitemap.querySelectorAll("sitemap");
          console.log(`Sitemap index detected with ${nestedSitemaps.length} nested sitemaps`);

          for (const sitemap of nestedSitemaps) {
            try {
              const sitemapPage = sitemap.querySelector("loc")?.innerText?.trim();
              if (!sitemapPage) {
                console.log(`  Skipping nested sitemap with empty loc`);
                continue;
              }

              console.log(`  Fetching nested sitemap: ${sitemapPage}`);

              // Fetch with timeout
              const nestedController = new AbortController();
              const nestedTimeoutId = setTimeout(() => nestedController.abort(), THRESHOLDS.FETCH_TIMEOUT);

              const sitemapPageResponse = await fetch(sitemapPage, { signal: nestedController.signal });
              clearTimeout(nestedTimeoutId);

              if (!sitemapPageResponse.ok) {
                console.log(`  Error: HTTP ${sitemapPageResponse.status} for nested sitemap ${sitemapPage}`);
                result.errors.push({
                  message: `Failed to fetch nested sitemap`,
                  detail: `HTTP ${sitemapPageResponse.status} for ${sitemapPage}`,
                  severity: SEVERITY.MEDIUM
                });
                continue;
              }

              const sitemapPageText = await sitemapPageResponse.text();
              const parsedSitemapPage = parse(sitemapPageText);
              const nestedUrls = parsedSitemapPage.querySelectorAll("url");

              console.log(`  Processing ${nestedUrls.length} URLs from nested sitemap`);
              this.processSitemap(nestedUrls, origin, sitemapPage, result);
            } catch (nestedError: unknown) {
              const nestedSitemapUrl = sitemap.querySelector("loc")?.innerText?.trim() || 'unknown';
              const nestedErr = nestedError as Error;
              const errorMessage = `Error processing nested sitemap ${nestedSitemapUrl}: ${nestedErr.name} ${nestedErr.message}`;
              console.log(`  ${errorMessage}`);
              result.errors.push({
                message: `Failed to process nested sitemap`,
                detail: errorMessage,
                severity: SEVERITY.MEDIUM
              });
              // Continue processing remaining sitemaps
            }
          }
        }
      } catch (error: unknown) {
        const err = error as Error;
        const message = `Error during processing sitemap ${sitemapUrl} ${err.name} ${err.message} ${err.cause || ''}`;
        result.errors.push({
          message,
          detail: '',
          severity: SEVERITY.HIGH
        });
        console.log(message);
      }
    }

    console.log(`Total URLs found in sitemaps: ${result.total}`);
    return result;
  }

  /**
   * Process a single sitemap and extract URLs
   * @param {Array} urls - Array of URL elements from parsed sitemap
   * @param {string} origin - Website origin
   * @param {string} currentSitemap - Current sitemap URL being processed
   * @param {object} result - Result object to update
   */
  static processSitemap(urls: HTMLElement[], origin: string, currentSitemap: string, result: SitemapParserResult) {
    const validChangefreqValues = ['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'];
    const unique = new Set<string>();
    const processedUrls: Record<string, SitemapParsedUrl> = {};

    for (const site of urls) {
      const loc = site.querySelector("loc")?.innerText?.trim();

      // Skip entries without valid loc
      if (!loc) {
        result.errors.push({
          message: `Empty or missing <loc> in sitemap`,
          detail: `Sitemap ${currentSitemap} contains an entry without a valid <loc> element`,
          severity: SEVERITY.MEDIUM
        });
        continue;
      }

      // Validate URL format
      try {
        new URL(loc);
      } catch (e) {
        result.errors.push({
          message: `Invalid URL format in sitemap`,
          detail: `URL "${loc}" in sitemap ${currentSitemap} is not a valid URL`,
          severity: SEVERITY.HIGH
        });
        continue;
      }

      const processedData: SitemapParsedUrl = {
        loc,
        lastmod: site.querySelector("lastmod")?.innerText,
        changefreq: site.querySelector("changefreq")?.innerText,
        priority: site.querySelector("priority")?.innerText,
      };

      // Validate lastmod date format (ISO 8601)
      if (processedData.lastmod) {
        const lastmodDate = new Date(processedData.lastmod);
        if (isNaN(lastmodDate.getTime())) {
          result.errors.push({
            message: `Invalid lastmod date format in sitemap`,
            detail: `URL ${processedData.loc} has invalid lastmod "${processedData.lastmod}" in sitemap ${currentSitemap}`,
            severity: SEVERITY.LOW
          });
        }
      }

      // Validate changefreq
      if (processedData.changefreq && !validChangefreqValues.includes(processedData.changefreq.toLowerCase())) {
        result.errors.push({
          message: `Invalid changefreq value in sitemap`,
          detail: `URL ${processedData.loc} has invalid changefreq "${processedData.changefreq}" in sitemap ${currentSitemap}`,
          severity: SEVERITY.LOW
        });
      }

      // Validate priority (0.0 to 1.0)
      if (processedData.priority) {
        const priority = parseFloat(processedData.priority);
        if (isNaN(priority) || priority < 0.0 || priority > 1.0) {
          result.errors.push({
            message: `Invalid priority value in sitemap`,
            detail: `URL ${processedData.loc} has invalid priority "${processedData.priority}" in sitemap ${currentSitemap} (must be between 0.0 and 1.0)`,
            severity: SEVERITY.LOW
          });
        }
      }

      unique.add(processedData.loc);

      // Extract alternate language links
      for (const alternate of site.querySelectorAll("xhtml:link")) {
        if (alternate.attributes.rel === "alternate") {
          if (!processedData.alternates) {
            processedData.alternates = {};
          }

          processedData.alternates[alternate.attributes.href] = {
            hreflang: alternate.attributes.hreflang,
            href: alternate.attributes.href,
          };
        }
      }

      processedUrls[processedData.loc] = processedData;
    }

    const locs = Object.keys(processedUrls);

    // Check sitemap size limit
    if (locs.length >= THRESHOLDS.SITEMAP_LIMIT) {
      result.errors.push({
        message: `Sitemap is reached the limit ${THRESHOLDS.SITEMAP_LIMIT} ${currentSitemap}`,
        detail: '',
        severity: SEVERITY.MEDIUM
      });
    }

    // Check for duplicates (O(n) using a frequency map instead of O(n²) reduce)
    if (unique.size !== locs.length) {
      const seen = new Set();
      const reported = new Set();
      for (const site of locs) {
        if (seen.has(site) && !reported.has(site)) {
          result.errors.push({
            message: "There are duplications in sitemap " + currentSitemap,
            detail: `Duplicate url: ${site} in sitemap: ${currentSitemap}`,
            severity: SEVERITY.HIGH
          });
          reported.add(site);
        }
        seen.add(site);
      }
    }

    // Check trailing slash consistency
    const withTrailingSlash: string[] = [];
    const withoutTrailingSlash: string[] = [];

    for (const site of unique) {
      // Check origin
      if (!site.startsWith(origin)) {
        result.errors.push({
          message: `Incorrect origin ${site} in sitemap ${currentSitemap}`,
          detail: '',
          severity: SEVERITY.HIGH
        });
      }

      // Track trailing slash usage
      if (site.endsWith("/")) {
        withTrailingSlash.push(site);
      } else {
        withoutTrailingSlash.push(site);
      }
    }

    if (withTrailingSlash.length && withoutTrailingSlash.length) {
      result.errors.push({
        message: `Trailing slash inconsistencies in sitemap ${currentSitemap}: withTrailingSlash = ${withTrailingSlash.length}, withoutTrailingLSlash = ${withoutTrailingSlash.length}`,
        detail: '',
        severity: SEVERITY.MEDIUM
      });
    }

    // Store sitemap data
    result.sitemaps[currentSitemap] = {
      total: locs.length,
      totalUnique: unique.size,
      urls: processedUrls,
    };

    // Merge URLs into combined result
    result.urls = {
      ...result.urls,
      ...processedUrls,
    };
    result.total += unique.size;
  }
}

export { SitemapParser };

import { RobotsParser } from './robots-parser';

// CLI testing
const isMainModule = typeof require !== 'undefined' && require.main === module;
const isDirectRun = process.argv[1]?.endsWith('sitemap-parser.ts') || process.argv[1]?.endsWith('sitemap-parser.js');
if (isMainModule || isDirectRun) {
  (async () => {
    const testUrl = process.argv[2] || 'https://example.com';
    console.log(`Testing SitemapParser with ${testUrl}\n`);

    // First get sitemaps from robots.txt
    const robotsResult = await RobotsParser.parseRobotsTxt(testUrl);

    if (!robotsResult.sitemaps.length) {
      console.log('No sitemaps found in robots.txt');
      return;
    }

    console.log(`\nFound ${robotsResult.sitemaps.length} sitemap(s) in robots.txt:`);
    robotsResult.sitemaps.forEach(s => console.log('  -', s));

    console.log('\n--- Parsing Sitemaps ---\n');
    const result = await SitemapParser.parseSitemaps(testUrl, robotsResult.sitemaps);

    console.log('\n📊 Results:');
    console.log('Total URLs:', result.total);
    console.log('Sitemaps processed:', Object.keys(result.sitemaps).length);

    Object.entries(result.sitemaps).forEach(([url, data]: [string, SitemapEntry]) => {
      console.log(`\n  ${url}:`);
      console.log(`    - Total: ${data.total}`);
      console.log(`    - Unique: ${data.totalUnique}`);
    });

    console.log('\nErrors/Warnings:', result.errors.length);
    result.errors.forEach((err: { message: string; detail: string; severity: string }) => {
      console.log(`  - [${err.severity}] ${err.message}`);
      if (err.detail) console.log(`    ${err.detail}`);
    });

    // Show a few sample URLs
    const sampleUrls = Object.keys(result.urls).slice(0, 5);
    if (sampleUrls.length) {
      console.log('\nSample URLs (first 5):');
      sampleUrls.forEach(url => console.log(`  - ${url}`));
    }
  })();
}
