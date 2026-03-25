/**
 * Anchor Text Analyzer
 * Analyzes internal link anchor text distribution and over-optimization
 */

import { SEVERITY, GENERIC_ANCHORS } from '../../constants';
import { isInternalLink, getOrigin } from '../../utils';
import type { Issue, PageInfo } from '../../types';

interface PageLink {
  href?: string;
  url?: string;
  text?: string;
  anchor?: string;
  hasImage?: boolean;
  containsImage?: boolean;
  imgAlt?: string;
  [key: string]: unknown;
}

// Stop words to ignore in anchor text analysis
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'as',
  'is',
  'was',
  'are',
  'were',
  'been',
  'be',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'must',
  'shall',
  'can',
  'need',
  'dare',
  'ought',
  'used',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'what',
  'which',
  'who',
  'whom',
  'whose',
  'where',
  'when',
  'why',
  'how',
  'all',
  'each',
  'every',
  'both',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'nor',
  'not',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  'just',
  'also',
  'now',
  'here',
  'there',
]);

class AnchorTextAnalyzer {
  /**
   * Analyze anchor text for a page
   * @param {object} pageData - Page data with links
   * @param {string} url - Page URL
   * @returns {object} Analysis results
   */
  static analyze(pageData: PageInfo, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info = {
      totalLinks: 0,
      internalLinks: 0,
      externalLinks: 0,
      genericAnchors: [] as { href: string; anchor: string }[],
      emptyAnchors: [] as string[],
      imageOnlyLinks: [] as { href: string; hasAlt: boolean }[],
      duplicateAnchors: {} as Record<string, string[]>,
      anchorDistribution: {} as Record<string, number>,
      avgAnchorLength: 0,
    };

    const links: PageLink[] = Array.isArray(pageData.links) ? (pageData.links as PageLink[]) : [];
    const pageOrigin = getOrigin(url);

    let totalAnchorLength = 0;
    let anchorCount = 0;

    for (const link of links) {
      const href = String(link.href ?? link.url ?? '');
      const anchor = (link.text ?? link.anchor ?? '').trim();
      const hasImage = link.hasImage ?? link.containsImage ?? false;

      info.totalLinks++;

      // Classify link
      const isInternal = isInternalLink(href, pageOrigin);
      if (isInternal) {
        info.internalLinks++;
      } else {
        info.externalLinks++;
        continue; // Focus on internal links for SEO
      }

      // Check for empty anchor
      if (!anchor || anchor.length === 0) {
        if (hasImage) {
          info.imageOnlyLinks.push({ href, hasAlt: link.imgAlt ? true : false });
        } else {
          info.emptyAnchors.push(href);
        }
        continue;
      }

      // Track anchor length
      totalAnchorLength += anchor.length;
      anchorCount++;

      // Check for generic anchors
      const normalizedAnchor = anchor.toLowerCase().trim();
      if ((GENERIC_ANCHORS as readonly string[]).includes(normalizedAnchor)) {
        info.genericAnchors.push({ href, anchor });
      }

      // Track anchor text distribution
      if (!info.anchorDistribution[normalizedAnchor]) {
        info.anchorDistribution[normalizedAnchor] = 0;
      }
      info.anchorDistribution[normalizedAnchor]++;

      // Track duplicates pointing to different URLs
      if (!info.duplicateAnchors[normalizedAnchor]) {
        info.duplicateAnchors[normalizedAnchor] = [];
      }
      if (!info.duplicateAnchors[normalizedAnchor].includes(href)) {
        info.duplicateAnchors[normalizedAnchor].push(href);
      }
    }

    // Calculate average
    info.avgAnchorLength = anchorCount > 0 ? Math.round(totalAnchorLength / anchorCount) : 0;

    // Report issues
    // Empty anchors
    if (info.emptyAnchors.length > 0) {
      issues.push({
        message: 'Links with empty anchor text',
        detail: `${info.emptyAnchors.length} internal links have no anchor text. Examples: ${info.emptyAnchors.slice(0, 3).join(', ')}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Image-only links without alt
    const imageLinksNoAlt = info.imageOnlyLinks.filter((l) => !l.hasAlt);
    if (imageLinksNoAlt.length > 0) {
      issues.push({
        message: 'Image links without alt text',
        detail: `${imageLinksNoAlt.length} links contain only images with no alt text. Search engines need descriptive anchor/alt text.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Generic anchors
    if (info.genericAnchors.length > 3) {
      warnings.push({
        message: 'Too many generic anchor texts',
        detail: `${info.genericAnchors.length} links use generic anchors like "click here", "read more". Use descriptive anchor text for better SEO.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Over-optimized anchors (same exact anchor used many times)
    const overused = (Object.entries(info.anchorDistribution) as [string, number][])
      .filter(([anchor, count]) => count > 5 && !(GENERIC_ANCHORS as readonly string[]).includes(anchor))
      .sort((a, b) => b[1] - a[1]);

    if (overused.length > 0) {
      const examples = overused
        .slice(0, 3)
        .map(([a, c]) => `"${a}" (${c}x)`)
        .join(', ');
      warnings.push({
        message: 'Potentially over-optimized anchor text',
        detail: `Same anchor text used excessively: ${examples}. Vary anchor text to appear natural.`,
        severity: SEVERITY.LOW,
      });
    }

    // Same anchor pointing to different pages
    const confusingAnchors = Object.entries(info.duplicateAnchors).filter(
      ([anchor, urls]) => urls.length > 1 && !(GENERIC_ANCHORS as readonly string[]).includes(anchor),
    );

    if (confusingAnchors.length > 0) {
      const examples = confusingAnchors
        .slice(0, 2)
        .map(([a, urls]) => `"${a}" → ${urls.length} different URLs`)
        .join(', ');
      warnings.push({
        message: 'Same anchor text links to different pages',
        detail: `Confusing for users and search engines: ${examples}. Use unique anchors for different destinations.`,
        severity: SEVERITY.LOW,
      });
    }

    // Very short anchors (1-2 words excluding stop words)
    const shortAnchors = Object.keys(info.anchorDistribution).filter(
      (anchor) => this.getSignificantWordCount(anchor) < 2 && !(GENERIC_ANCHORS as readonly string[]).includes(anchor),
    );

    if (shortAnchors.length > info.internalLinks * 0.3 && info.internalLinks > 5) {
      warnings.push({
        message: 'Many links have very short anchor text',
        detail: `${shortAnchors.length} anchors have less than 2 significant words. Consider more descriptive anchor text.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }

  /**
   * Get significant word count (excluding stop words)
   * @param {string} text
   * @returns {number}
   */
  static getSignificantWordCount(text: string) {
    const words = text.toLowerCase().split(/\s+/);
    return words.filter((w) => w.length > 2 && !STOP_WORDS.has(w)).length;
  }

  /**
   * Analyze anchor text across the site
   * @param {object} pages - All pages data
   * @param {string} origin - Site origin
   * @returns {object} Site-wide analysis
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>, origin: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const stats = {
      totalInternalLinks: 0,
      totalGenericAnchors: 0,
      totalEmptyAnchors: 0,
      totalImageOnlyLinks: 0,
      siteWideAnchorDistribution: {},
      topAnchors: [] as { anchor: string; count: number }[],
      anchorDiversity: 0,
    };

    const targetAnchorMap = new Map(); // target URL -> anchor texts used

    for (const [_url, pageData] of Object.entries(pages)) {
      const links: PageLink[] = Array.isArray(pageData.links) ? (pageData.links as PageLink[]) : [];

      for (const link of links) {
        const href = String(link.href ?? link.url ?? '');
        const anchor = (link.text ?? link.anchor ?? '').trim().toLowerCase();

        if (!href || !isInternalLink(href, origin)) continue;

        stats.totalInternalLinks++;

        // Normalize target URL
        let targetUrl;
        try {
          targetUrl = new URL(href, origin).pathname;
        } catch {
          targetUrl = href;
        }

        // Track anchors per target
        if (!targetAnchorMap.has(targetUrl)) {
          targetAnchorMap.set(targetUrl, new Map());
        }
        const anchors = targetAnchorMap.get(targetUrl);
        anchors.set(anchor, (anchors.get(anchor) ?? 0) + 1);

        // Track site-wide distribution
        if (anchor && !(GENERIC_ANCHORS as readonly string[]).includes(anchor)) {
          (stats.siteWideAnchorDistribution as Record<string, number>)[anchor] =
            ((stats.siteWideAnchorDistribution as Record<string, number>)[anchor] || 0) + 1;
        }

        // Count generics and empties
        if (!anchor) {
          stats.totalEmptyAnchors++;
        } else if ((GENERIC_ANCHORS as readonly string[]).includes(anchor)) {
          stats.totalGenericAnchors++;
        }

        if (link.hasImage && !anchor) {
          stats.totalImageOnlyLinks++;
        }
      }
    }

    // Calculate diversity
    const uniqueAnchors = Object.keys(stats.siteWideAnchorDistribution).length;
    stats.anchorDiversity =
      stats.totalInternalLinks > 0 ? parseFloat(((uniqueAnchors / stats.totalInternalLinks) * 100).toFixed(1)) : 0;

    // Top anchors
    stats.topAnchors = (Object.entries(stats.siteWideAnchorDistribution) as [string, number][])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([anchor, count]) => ({ anchor, count }));

    // Site-wide issues
    const genericPercent =
      stats.totalInternalLinks > 0 ? ((stats.totalGenericAnchors / stats.totalInternalLinks) * 100).toFixed(1) : 0;

    if (parseFloat(genericPercent as string) > 20) {
      warnings.push({
        message: 'High percentage of generic anchor text',
        detail: `${genericPercent}% of internal links (${stats.totalGenericAnchors}) use generic anchors. Improve anchor text diversity.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (stats.totalEmptyAnchors > 10) {
      issues.push({
        message: 'Many links with empty anchor text',
        detail: `${stats.totalEmptyAnchors} internal links across the site have no anchor text.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check for anchor text concentration (same anchor used for same target)
    const overOptimizedTargets = [];
    for (const [target, anchors] of targetAnchorMap) {
      const totalLinks = (Array.from(anchors.values()) as number[]).reduce((a, b) => a + b, 0);
      if (totalLinks < 5) continue;

      for (const [anchor, count] of anchors.entries() as IterableIterator<[string, number]>) {
        const percentage = (count / totalLinks) * 100;
        if (percentage > 80 && count > 5 && !(GENERIC_ANCHORS as readonly string[]).includes(anchor)) {
          overOptimizedTargets.push({ target, anchor, percentage: percentage.toFixed(0), count });
        }
      }
    }

    if (overOptimizedTargets.length > 0) {
      const examples = overOptimizedTargets
        .slice(0, 3)
        .map((t) => `"${t.anchor}" → ${t.target} (${t.percentage}% of ${t.count} links)`)
        .join('; ');
      warnings.push({
        message: 'Anchor text over-optimization detected',
        detail: `Some pages receive links with identical anchor text: ${examples}. Vary anchor text.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Low diversity warning
    if (stats.anchorDiversity < 30 && stats.totalInternalLinks > 50) {
      warnings.push({
        message: 'Low anchor text diversity',
        detail: `Only ${stats.anchorDiversity}% unique anchors across ${stats.totalInternalLinks} internal links. More variety recommended.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, stats };
  }
}

export { AnchorTextAnalyzer };
