/**
 * Content Freshness Analyzer
 * Analyzes content update signals and freshness indicators
 */

import { SEVERITY } from '../../constants';
import type { Issue, ParsedPage, PageInfo } from '../../types';

class FreshnessAnalyzer {
  /**
   * Analyze content freshness signals
   * @param {Object} pageData - Page data with headers and content
   * @param {Object} response - HTTP response object
   * @param {Object} parsedPage - Parsed HTML page
   * @returns {Object} Analysis results with freshness data and issues
   */
  static analyze(pageData: PageInfo, response: Record<string, any> | null, parsedPage: ParsedPage) {
    const issues: Record<string, any>[] = [];
    const freshnessData = {
      lastModified: null as string | null,
      datePublished: null as string | null,
      dateModified: null as string | null,
      copyrightYear: null as number | null,
      lastUpdatedText: null as string | null,
      freshnessScore: 0,
      ageInDays: null as number | null,
    };

    const now = new Date();

    // Check Last-Modified header
    const lastModifiedHeader = response?.headers?.['last-modified'];
    if (lastModifiedHeader) {
      try {
        const lastModDate = new Date(lastModifiedHeader);
        if (!isNaN(lastModDate.getTime())) {
          freshnessData.lastModified = lastModDate.toISOString();
          freshnessData.ageInDays = Math.floor((now.getTime() - lastModDate.getTime()) / (1000 * 60 * 60 * 24));
        }
      } catch {
        // Invalid date format
      }
    }

    // Extract dates from Schema.org structured data
    if (pageData.structuredData?.jsonLdSchemas) {
      for (const schemaInfo of pageData.structuredData.jsonLdSchemas) {
        const schema = schemaInfo.raw;
        if (!schema) continue;

        if (schema.datePublished) {
          try {
            const pubDate = new Date(schema.datePublished);
            if (!isNaN(pubDate.getTime())) {
              freshnessData.datePublished = pubDate.toISOString();
            }
          } catch {
            // Invalid date format in schema - skip silently
          }
        }
        if (schema.dateModified) {
          try {
            const modDate = new Date(schema.dateModified);
            if (!isNaN(modDate.getTime())) {
              freshnessData.dateModified = modDate.toISOString();
            }
          } catch {
            // Invalid date format in schema - skip silently
          }
        }
      }
    }

    // Check for meta article dates
    if (parsedPage) {
      const metaPublished = parsedPage.querySelector('meta[property="article:published_time"]');
      const metaModified = parsedPage.querySelector('meta[property="article:modified_time"]');

      if (metaPublished && !freshnessData.datePublished) {
        try {
          const pubDate = new Date(metaPublished.getAttribute('content')!);
          if (!isNaN(pubDate.getTime())) {
            freshnessData.datePublished = pubDate.toISOString();
          }
        } catch {
          // Invalid date format in meta tag - skip silently
        }
      }

      if (metaModified && !freshnessData.dateModified) {
        try {
          const modDate = new Date(metaModified.getAttribute('content')!);
          if (!isNaN(modDate.getTime())) {
            freshnessData.dateModified = modDate.toISOString();
          }
        } catch {
          // Invalid date format in meta tag - skip silently
        }
      }

      // Look for copyright year in footer
      const footer = parsedPage.querySelector('footer');
      if (footer) {
        const footerText = footer.text || '';
        const copyrightMatch = footerText.match(/©\s*(\d{4})|copyright\s*(\d{4})/i);
        if (copyrightMatch) {
          freshnessData.copyrightYear = parseInt(copyrightMatch[1] || copyrightMatch[2], 10);
        }
      }

      // Look for "last updated" or "updated on" text
      const bodyText = parsedPage.text || '';
      const updatePatterns = [
        /last\s+updated[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
        /updated\s+on[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
        /modified[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
      ];

      for (const pattern of updatePatterns) {
        const match = bodyText.match(pattern);
        if (match) {
          freshnessData.lastUpdatedText = match[1];
          break;
        }
      }
    }

    // Calculate freshness score (0-100)
    freshnessData.freshnessScore = this.calculateFreshnessScore(freshnessData, now);

    // Generate issues based on freshness analysis
    if (freshnessData.ageInDays !== null) {
      if (freshnessData.ageInDays > 365) {
        issues.push({
          type: 'stale_content',
          message: 'Content may be stale',
          detail: `Last modified ${freshnessData.ageInDays} days ago (${Math.floor(freshnessData.ageInDays / 365)} years). Consider updating if content is time-sensitive`,
          severity: SEVERITY.LOW,
        });
      }
    }

    // Check for date inconsistencies
    if (freshnessData.datePublished && freshnessData.dateModified) {
      const pubDate = new Date(freshnessData.datePublished);
      const modDate = new Date(freshnessData.dateModified);

      if (modDate < pubDate) {
        issues.push({
          type: 'date_inconsistency',
          message: 'dateModified is earlier than datePublished',
          detail: `Published: ${freshnessData.datePublished}, Modified: ${freshnessData.dateModified}. This may confuse search engines`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Check for future dates (common mistake)
    const checkDates = [freshnessData.datePublished, freshnessData.dateModified, freshnessData.lastModified];
    for (const dateStr of checkDates) {
      if (dateStr) {
        const date = new Date(dateStr);
        if (date > now) {
          issues.push({
            type: 'future_date',
            message: 'Content has a date in the future',
            detail: `Date ${dateStr} is in the future. This may cause indexing issues`,
            severity: SEVERITY.MEDIUM,
          });
          break;
        }
      }
    }

    // Check for outdated copyright
    if (freshnessData.copyrightYear) {
      const currentYear = now.getFullYear();
      if (freshnessData.copyrightYear < currentYear - 1) {
        issues.push({
          type: 'outdated_copyright',
          message: 'Copyright year is outdated',
          detail: `Footer shows ${freshnessData.copyrightYear}, current year is ${currentYear}. Update copyright to appear current`,
          severity: SEVERITY.LOW,
        });
      }
    }

    // Missing freshness signals
    if (!freshnessData.lastModified && !freshnessData.dateModified && !freshnessData.datePublished) {
      issues.push({
        type: 'no_freshness_signals',
        message: 'No content freshness signals found',
        detail: `Consider adding Last-Modified header or datePublished/dateModified in Schema.org markup`,
        severity: SEVERITY.LOW,
      });
    }

    return {
      freshnessData,
      issues,
    };
  }

  /**
   * Calculate a freshness score (0-100)
   * @param {Object} freshnessData - Freshness data object
   * @param {Date} now - Current date
   * @returns {number} Freshness score
   */
  static calculateFreshnessScore(freshnessData: Record<string, any>, now: Date) {
    let score: number;

    // Get the most recent date we have
    const dates = [
      freshnessData.lastModified,
      freshnessData.dateModified,
      freshnessData.datePublished,
    ].filter(Boolean).map(d => new Date(d));

    if (dates.length === 0) {
      return 50; // No data, neutral score
    }

    const mostRecent = new Date(Math.max(...dates.map(d => d.getTime())));
    const ageInDays = Math.floor((now.getTime() - mostRecent.getTime()) / (1000 * 60 * 60 * 24));

    // Scoring based on age
    if (ageInDays <= 7) {
      score = 100; // Updated within a week
    } else if (ageInDays <= 30) {
      score = 90; // Updated within a month
    } else if (ageInDays <= 90) {
      score = 80; // Updated within 3 months
    } else if (ageInDays <= 180) {
      score = 70; // Updated within 6 months
    } else if (ageInDays <= 365) {
      score = 60; // Updated within a year
    } else if (ageInDays <= 730) {
      score = 40; // 1-2 years old
    } else {
      score = 20; // Over 2 years old
    }

    // Bonus for having structured date markup
    if (freshnessData.datePublished || freshnessData.dateModified) {
      score = Math.min(100, score + 5);
    }

    return score;
  }

  /**
   * Analyze freshness patterns site-wide
   * @param {Object} pages - All pages data
   * @returns {Object} Site-wide freshness analysis
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    const freshnessScores = [];
    const ages = [];
    let pagesWithDates = 0;
    let pagesWithoutDates = 0;
    let stalePages = 0;

    for (const [_url, page] of Object.entries(pages)) {
      if (page.freshnessData) {
        freshnessScores.push(page.freshnessData.freshnessScore);

        if (page.freshnessData.ageInDays !== null) {
          ages.push(page.freshnessData.ageInDays);
          pagesWithDates++;

          if (page.freshnessData.ageInDays > 365) {
            stalePages++;
          }
        } else {
          pagesWithoutDates++;
        }
      }
    }

    const totalPages = Object.keys(pages).length;

    // Check for site-wide freshness issues
    if (pagesWithoutDates > totalPages * 0.5) {
      warnings.push({
        message: 'Most pages lack freshness signals',
        detail: `${pagesWithoutDates} of ${totalPages} pages (${((pagesWithoutDates/totalPages)*100).toFixed(1)}%) have no date information. Consider adding Last-Modified headers or Schema.org dates`,
        severity: SEVERITY.LOW,
      });
    }

    if (stalePages > totalPages * 0.3) {
      issues.push({
        message: 'Many pages have stale content',
        detail: `${stalePages} of ${totalPages} pages (${((stalePages/totalPages)*100).toFixed(1)}%) haven't been updated in over a year`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Calculate site-wide freshness metrics
    const avgScore = freshnessScores.length > 0
      ? freshnessScores.reduce((a, b) => a + b, 0) / freshnessScores.length
      : 50;

    const avgAge = ages.length > 0
      ? ages.reduce((a, b) => a + b, 0) / ages.length
      : null;

    return {
      issues,
      warnings,
      metrics: {
        averageFreshnessScore: Math.round(avgScore),
        averageAgeInDays: avgAge ? Math.round(avgAge) : null,
        pagesWithDates,
        pagesWithoutDates,
        stalePages,
      },
    };
  }
}

export { FreshnessAnalyzer };