/**
 * Keyword Cannibalisation Analyzer
 * Detects pages competing for the same keywords
 */

import { SEVERITY, STOP_WORDS } from '../../constants';
import { shortenUrl, jaccardSimilarity, getHostname, getPathSegments, truncateText } from '../../utils';
import type { Issue, PageInfo } from '../../types';

interface TitleConflictPage {
  url: string;
  title: string;
}

interface H1ConflictPage {
  url: string;
  h1: string;
}

type ConflictPage = TitleConflictPage | H1ConflictPage;

// Extends shared STOP_WORDS with keyword-cannibalisation-specific low-value words
const KEYWORD_EXTRA_STOPWORDS = ['once', 'before', 'above', 'below', 'between', 'through', 'during', 'under', 'again', 'further', 'get', 'best', 'top', 'free', 'guide', 'tips', 'ways', 'things'];
const STOPWORDS = new Set([...STOP_WORDS, ...KEYWORD_EXTRA_STOPWORDS]);

class KeywordCannibalisationAnalyzer {
  /**
   * Detect brand name from domain
   */
  static detectBrandName(pages: Record<string, PageInfo>): Set<string> {
    const brandWords = new Set<string>();

    for (const url of Object.keys(pages)) {
      const hostname = getHostname(url);
      if (hostname) {
        // e.g. "ringgo.co.uk" -> "ringgo"
        const domainPart = hostname.split('.')[0];
        if (domainPart && domainPart.length >= 3) {
          brandWords.add(domainPart.toLowerCase());
        }
      }
      break; // Only need one URL
    }

    return brandWords;
  }

  /**
   * Check if a keyword phrase is dominated by brand terms
   */
  static isBrandKeyword(keyword: string, brandWords: Set<string>): boolean {
    const words = keyword.split(' ').filter((w) => !this.isStopword(w));
    if (words.length === 0) return false;
    return words.every((w) => brandWords.has(w));
  }

  /**
   * Remove keywords that are subsets of other keywords in the same conflict set
   * e.g. if "corporate solutions form" is flagged, remove "corporate solutions" and "solutions form"
   */
  static deduplicateSubsumedPhrases<T extends ConflictPage>(conflicts: Map<string, T[]>): Map<string, T[]> {
    const keywords = Array.from(conflicts.keys());
    const toRemove = new Set<string>();

    for (const shorter of keywords) {
      for (const longer of keywords) {
        if (shorter === longer) continue;
        if (shorter.split(' ').length >= longer.split(' ').length) continue;
        if (longer.includes(shorter)) {
          const shorterPages = new Set(conflicts.get(shorter)!.map((p: ConflictPage) => p.url));
          const longerPages = conflicts.get(longer)!.map((p: ConflictPage) => p.url);
          // If all pages of the longer phrase are also in the shorter phrase, remove shorter
          if (longerPages.every((url: string) => shorterPages.has(url))) {
            toRemove.add(shorter);
          }
        }
      }
    }

    const result = new Map(conflicts);
    for (const key of toRemove) {
      result.delete(key);
    }
    return result;
  }

  /**
   * Analyze site for keyword cannibalisation
   * @param {Object} pages - All pages data
   * @returns {Object} Analysis results
   */
  static analyze(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const brandWords = this.detectBrandName(pages);

    // Build keyword maps
    const titleKeywords = new Map<string, TitleConflictPage[]>(); // keyword -> [urls]
    const h1Keywords = new Map<string, H1ConflictPage[]>(); // keyword -> [urls]
    const topicClusters = new Map<string, string[]>(); // topic -> [urls]

    for (const [url, page] of Object.entries(pages)) {
      // Skip error pages
      if (page.status !== 200) continue;

      // Extract and normalize title keywords
      if (page.title) {
        const keywords = this.extractKeywords(page.title);
        for (const keyword of keywords) {
          if (!titleKeywords.has(keyword)) {
            titleKeywords.set(keyword, []);
          }
          titleKeywords.get(keyword)!.push({ url, title: page.title });
        }
      }

      // Extract H1 keywords
      if (page.headings?.h1?.[0]) {
        const h1 = page.headings.h1[0];
        const keywords = this.extractKeywords(h1);
        for (const keyword of keywords) {
          if (!h1Keywords.has(keyword)) {
            h1Keywords.set(keyword, []);
          }
          h1Keywords.get(keyword)!.push({ url, h1 });
        }
      }

      // Extract topic from URL and content
      const topic = this.extractTopic(url, page);
      if (topic) {
        if (!topicClusters.has(topic)) {
          topicClusters.set(topic, []);
        }
        topicClusters.get(topic)!.push(url);
      }
    }

    // Find cannibalisation in titles
    let titleConflicts = this.findConflicts(titleKeywords, 2);
    titleConflicts = this.deduplicateSubsumedPhrases(titleConflicts);
    for (const [keyword, pages] of titleConflicts) {
      if (this.isSignificantKeyword(keyword, pages.length) && !this.isBrandKeyword(keyword, brandWords)) {
        issues.push({
          message: `Multiple pages targeting keyword: "${keyword}"`,
          detail: `${pages.length} pages have this keyword in title: ${pages
            .slice(0, 3)
            .map((p: ConflictPage) => `<a href="${p.url}">${shortenUrl(p.url)}</a>`)
            .join(', ')}${pages.length > 3 ? ` (+${pages.length - 3} more)` : ''}`,
          severity: pages.length > 3 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
        });
      }
    }

    // Find cannibalisation in H1s
    let h1Conflicts = this.findConflicts(h1Keywords, 2);
    h1Conflicts = this.deduplicateSubsumedPhrases(h1Conflicts);
    for (const [keyword, pages] of h1Conflicts) {
      if (
        this.isSignificantKeyword(keyword, pages.length) &&
        !titleConflicts.has(keyword) &&
        !this.isBrandKeyword(keyword, brandWords)
      ) {
        warnings.push({
          message: `Multiple pages with similar H1 keyword: "${keyword}"`,
          detail: `${pages.length} pages target this in H1: ${pages
            .slice(0, 3)
            .map((p: ConflictPage) => `<a href="${p.url}">${shortenUrl(p.url)}</a>`)
            .join(', ')}`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Find topic clusters with potential conflicts
    for (const [topic, urls] of topicClusters) {
      if (urls.length > 5) {
        warnings.push({
          message: `Many pages on topic: "${topic}"`,
          detail: `${urls.length} pages appear to cover "${topic}". Consider consolidating or creating a clear content hierarchy.`,
          severity: SEVERITY.LOW,
        });
      }
    }

    // Check for near-duplicate titles
    const nearDuplicates = this.findNearDuplicateTitles(pages);
    for (const group of nearDuplicates) {
      issues.push({
        message: 'Near-duplicate page titles detected',
        detail: `These pages have very similar titles: ${group.map((p) => `<a href="${p.url}">"${truncateText(p.title ?? '', 40)}"</a>`).join(', ')}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return {
      issues,
      warnings,
      metrics: {
        titleConflicts: titleConflicts.size,
        h1Conflicts: h1Conflicts.size,
        topicClusters: topicClusters.size,
        nearDuplicateTitles: nearDuplicates.length,
      },
      conflicts: {
        titleKeywords: Array.from(titleConflicts.entries()).slice(0, 10),
        h1Keywords: Array.from(h1Conflicts.entries()).slice(0, 10),
      },
    };
  }

  /**
   * Extract significant keywords from text
   */
  static extractKeywords(text: string): string[] {
    if (!text) return [];

    // Normalize text
    const normalized = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Extract 2-4 word phrases
    const words = normalized.split(' ').filter((w) => w.length > 2);
    const keywords = new Set<string>();

    // Single significant words (4+ chars, not stopwords)
    for (const word of words) {
      if (word.length >= 4 && !this.isStopword(word)) {
        keywords.add(word);
      }
    }

    // Two-word phrases
    for (let i = 0; i < words.length - 1; i++) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      if (!this.isStopword(words[i]) || !this.isStopword(words[i + 1])) {
        keywords.add(phrase);
      }
    }

    // Three-word phrases
    for (let i = 0; i < words.length - 2; i++) {
      const phrase = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      keywords.add(phrase);
    }

    return Array.from(keywords);
  }

  /**
   * Extract main topic from URL and content
   */
  static extractTopic(url: string, _page: PageInfo) {
    try {
      const parsed = new URL(url);
      const pathParts = getPathSegments(parsed.pathname);

      // Use first meaningful path segment as topic
      for (const part of pathParts) {
        const normalized = part.replace(/[-_]/g, ' ').replace(/\d+/g, '').trim().toLowerCase();

        if (normalized.length >= 3 && !this.isStopword(normalized)) {
          return normalized;
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  /**
   * Find keywords with multiple pages
   */
  static findConflicts<T extends ConflictPage>(keywordMap: Map<string, T[]>, minCount: number) {
    const conflicts = new Map<string, T[]>();

    for (const [keyword, pages] of keywordMap) {
      if (pages.length >= minCount) {
        conflicts.set(keyword, pages);
      }
    }

    // Sort by number of conflicts
    return new Map([...conflicts.entries()].sort((a, b) => b[1].length - a[1].length));
  }

  /**
   * Check if keyword is significant enough to flag
   */
  static isSignificantKeyword(keyword: string, pageCount: number) {
    const words = keyword.split(' ');
    // Single words: require 8+ chars and 3+ pages
    if (words.length === 1) {
      return keyword.length >= 8 && pageCount >= 3;
    }
    // Two-word phrases: require 3+ pages
    if (words.length === 2) {
      return pageCount >= 3;
    }
    // Three+ word phrases: 2 pages is enough
    return true;
  }

  /**
   * Find near-duplicate titles using similarity
   */
  static findNearDuplicateTitles(pages: Record<string, PageInfo>) {
    const groups = [];
    const processed = new Set();
    const pageList = Object.entries(pages)
      .filter(([_, p]) => p.status === 200 && p.title)
      .map(([url, p]) => ({ url, title: p.title }));

    for (let i = 0; i < pageList.length; i++) {
      if (processed.has(pageList[i].url)) continue;

      const group = [pageList[i]];
      const baseTitle = this.normalizeForComparison(pageList[i].title ?? '');

      for (let j = i + 1; j < pageList.length; j++) {
        if (processed.has(pageList[j].url)) continue;

        const compareTitle = this.normalizeForComparison(pageList[j].title ?? '');
        const similarity = this.calculateSimilarity(baseTitle, compareTitle);

        if (similarity > 0.85) {
          group.push(pageList[j]);
          processed.add(pageList[j].url);
        }
      }

      if (group.length > 1) {
        groups.push(group);
        processed.add(pageList[i].url);
      }
    }

    return groups;
  }

  /**
   * Normalize title for comparison
   */
  static normalizeForComparison(title: string) {
    return title
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter((w) => !this.isStopword(w))
      .join(' ');
  }

  /**
   * Calculate Jaccard similarity between two strings
   */
  static calculateSimilarity(str1: string, str2: string) {
    return jaccardSimilarity(new Set(str1.split(' ')), new Set(str2.split(' ')));
  }

  /**
   * Check if word is a stopword
   */
  static isStopword(word: string) {
    return STOPWORDS.has(word.toLowerCase());
  }

}

export { KeywordCannibalisationAnalyzer };
