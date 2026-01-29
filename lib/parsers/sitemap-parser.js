/**
 * Sitemap Parser
 * Fetches and parses XML sitemaps according to the sitemap protocol
 */

const { parse } = require("node-html-parser");
const { SEVERITY, THRESHOLDS } = require('../constants');

class SitemapParser {
  /**
   * Fetch and parse sitemaps from given URLs
   * @param {string} origin - Website origin URL
   * @param {string[]} sitemapUrls - Array of sitemap URLs from robots.txt
   * @returns {Promise<object>} Parsed sitemap data and any errors found
   */
  static async parseSitemaps(origin, sitemapUrls) {
    const result = {
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
            } catch (nestedError) {
              const nestedSitemapUrl = sitemap.querySelector("loc")?.innerText?.trim() || 'unknown';
              const errorMessage = `Error processing nested sitemap ${nestedSitemapUrl}: ${nestedError.name} ${nestedError.message}`;
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
      } catch (error) {
        const message = `Error during processing sitemap ${sitemapUrl} ${error.name} ${error.message} ${error.cause || ''}`;
        result.errors.push({
          message,
          detail: null,
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
  static processSitemap(urls, origin, currentSitemap, result) {
    const validChangefreqValues = ['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'];
    const unique = new Set();
    const processedUrls = {};

    for (const site of urls) {
      const processedData = {
        loc: site.querySelector("loc")?.innerText,
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
        detail: null,
        severity: SEVERITY.MEDIUM
      });
    }

    // Check for duplicates
    if (unique.size !== locs.length) {
      for (const site of locs) {
        const count = locs.reduce((acc, curr) => {
          if (curr === site) {
            return acc + 1;
          }
          return acc;
        }, 0);

        if (count > 1) {
          result.errors.push({
            message: "There are duplications in sitemap " + currentSitemap,
            detail: `Duplicate url: ${site} in sitemap: ${currentSitemap}`,
            severity: SEVERITY.HIGH
          });
        }
      }
    }

    // Check trailing slash consistency
    const withTrailingSlash = [];
    const withoutTrailingSlash = [];

    for (const site of unique) {
      // Check origin
      if (!site.startsWith(origin)) {
        result.errors.push({
          message: `Incorrect origin ${site} in sitemap ${currentSitemap}`,
          detail: null,
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
        detail: null,
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
    result.total += locs.length;
  }
}

module.exports = { SitemapParser };

// CLI testing
if (require.main === module) {
  (async () => {
    const testUrl = process.argv[2] || 'https://example.com';
    console.log(`Testing SitemapParser with ${testUrl}\n`);

    // First get sitemaps from robots.txt
    const { RobotsParser } = require('./robots-parser');
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

    Object.entries(result.sitemaps).forEach(([url, data]) => {
      console.log(`\n  ${url}:`);
      console.log(`    - Total: ${data.total}`);
      console.log(`    - Unique: ${data.totalUnique}`);
    });

    console.log('\nErrors/Warnings:', result.errors.length);
    result.errors.forEach(err => {
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
