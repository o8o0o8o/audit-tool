/**
 * Content Similarity Analyzer
 * Detects near-duplicate content across pages using shingle-based similarity.
 * Goes beyond exact duplicate title/description checking to find pages
 * with substantially similar body content.
 */

import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

class ContentSimilarityAnalyzer {
  /**
   * Analyze content similarity across all pages
   * @param {object} allPages - All page data { url: pageData }
   * @returns {object} Analysis results
   */
  static analyze(allPages: Record<string, PageInfo>, config: Record<string, unknown> = {}) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const pages = Object.entries(allPages);

    if (pages.length < 2) {
      return { issues, warnings, similarGroups: [] };
    }

    // Build fingerprints for each page from content quality data
    const fingerprints = [];
    for (const [url, pageData] of pages) {
      const contentQuality = pageData.contentQuality;
      if (!contentQuality) continue;

      const keywords = contentQuality.topKeywords ?? [];
      const wordCount = contentQuality.wordCount || 0;

      // Skip pages with very little content
      if (wordCount < 50) continue;

      // Use top keywords and their relative density as a fingerprint
      // This is more efficient than full shingle comparison for large sites
      const fingerprint = ContentSimilarityAnalyzer.#buildFingerprint(keywords, wordCount);
      if (fingerprint.size > 0) {
        fingerprints.push({ url, fingerprint, wordCount });
      }
    }

    // Compare pairs using Jaccard similarity on fingerprint sets
    const similarGroups = [];
    const grouped = new Set();
    const SIMILARITY_THRESHOLD = (config.similarityThreshold as number) || 0.7;

    for (let i = 0; i < fingerprints.length; i++) {
      if (grouped.has(fingerprints[i].url)) continue;

      const group = [fingerprints[i].url];

      for (let j = i + 1; j < fingerprints.length; j++) {
        if (grouped.has(fingerprints[j].url)) continue;

        const similarity = ContentSimilarityAnalyzer.#jaccardSimilarity(
          fingerprints[i].fingerprint as Set<string>,
          fingerprints[j].fingerprint as Set<string>,
        );

        if (similarity >= SIMILARITY_THRESHOLD) {
          group.push(fingerprints[j].url);
          grouped.add(fingerprints[j].url);
        }
      }

      if (group.length > 1) {
        grouped.add(fingerprints[i].url);
        similarGroups.push({
          urls: group,
          pageCount: group.length,
        });
      }
    }

    // Report findings
    if (similarGroups.length > 0) {
      const totalAffected = similarGroups.reduce((sum, g) => sum + g.pageCount, 0);

      for (const group of similarGroups.slice(0, 10)) {
        const urlList = group.urls
          .slice(0, 5)
          .map((u) => `<li><a href="${u}">${u}</a></li>`)
          .join('');
        issues.push({
          title: `${group.pageCount} pages have very similar content`,
          description: `Near-duplicate content detected across these pages:<ul>${urlList}</ul>${group.urls.length > 5 ? `<p>...and ${group.urls.length - 5} more</p>` : ''}<p>Consider consolidating with canonical tags or differentiating the content.</p>`,
          severity: SEVERITY.MEDIUM,
        });
      }

      if (totalAffected > pages.length * 0.3 && totalAffected > 10) {
        warnings.push({
          title: `${Math.round((totalAffected / pages.length) * 100)}% of pages have near-duplicate content`,
          description: `${totalAffected} of ${pages.length} pages share very similar content across ${similarGroups.length} groups. This can dilute ranking signals.`,
          severity: SEVERITY.HIGH,
        });
      }
    }

    // Store similarity data on pages
    for (const group of similarGroups) {
      for (const url of group.urls) {
        if (allPages[url]) {
          allPages[url].contentSimilarity = {
            similarPages: group.urls.filter((u) => u !== url),
            groupSize: group.pageCount,
          };
        }
      }
    }

    return { issues, warnings, similarGroups };
  }

  /**
   * Build a content fingerprint from keyword analysis
   * Uses weighted keyword tokens as shingles
   * @param {Array} keywords - Top keywords [{word, count, density}]
   * @param {number} wordCount - Total word count
   * @returns {Set<string>} Fingerprint set
   * @private
   */
  static #buildFingerprint(keywords: { word: string; count: number; density: number }[], wordCount: number) {
    const fingerprint = new Set<string>();

    for (const kw of keywords) {
      // Create weighted tokens based on keyword prominence
      const density = typeof kw.density === 'number' ? kw.density : parseFloat(String(kw.density)) || 0;
      fingerprint.add(kw.word);

      // High-density keywords get additional weight tokens
      if (density > 1) {
        fingerprint.add(`${kw.word}:high`);
      }
      if (density > 2) {
        fingerprint.add(`${kw.word}:very-high`);
      }
    }

    // Add word count bucket as a structural signal
    const bucket = Math.floor(wordCount / 100) * 100;
    fingerprint.add(`wc:${bucket}`);

    return fingerprint;
  }

  /**
   * Calculate Jaccard similarity between two sets
   * @param {Set<string>} setA
   * @param {Set<string>} setB
   * @returns {number} Similarity score 0-1
   * @private
   */
  static #jaccardSimilarity(setA: Set<string>, setB: Set<string>) {
    if (setA.size === 0 && setB.size === 0) return 0;

    let intersection = 0;
    const smaller = setA.size <= setB.size ? setA : setB;
    const larger = setA.size <= setB.size ? setB : setA;

    for (const item of smaller) {
      if (larger.has(item)) intersection++;
    }

    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }
}

export { ContentSimilarityAnalyzer };
