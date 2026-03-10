/**
 * Keyword Cannibalisation Analyzer
 * Detects pages competing for the same keywords
 */

const { SEVERITY } = require('../../constants');

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'we', 'they', 'what', 'which', 'who', 'whom', 'how', 'when',
  'where', 'why', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'also', 'now', 'here', 'there',
  'then', 'once', 'about', 'after', 'before', 'above', 'below',
  'between', 'into', 'through', 'during', 'under', 'again', 'further',
  'any', 'our', 'your', 'their', 'his', 'her', 'my', 'get', 'best',
  'top', 'new', 'free', 'guide', 'tips', 'ways', 'things',
]);

class KeywordCannibalisationAnalyzer {
  /**
   * Analyze site for keyword cannibalisation
   * @param {Object} pages - All pages data
   * @returns {Object} Analysis results
   */
  static analyze(pages) {
    const issues = [];
    const warnings = [];

    // Build keyword maps
    const titleKeywords = new Map();  // keyword -> [urls]
    const h1Keywords = new Map();     // keyword -> [urls]
    const topicClusters = new Map();  // topic -> [urls]

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
          titleKeywords.get(keyword).push({ url, title: page.title });
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
          h1Keywords.get(keyword).push({ url, h1 });
        }
      }

      // Extract topic from URL and content
      const topic = this.extractTopic(url, page);
      if (topic) {
        if (!topicClusters.has(topic)) {
          topicClusters.set(topic, []);
        }
        topicClusters.get(topic).push(url);
      }
    }

    // Find cannibalisation in titles
    const titleConflicts = this.findConflicts(titleKeywords, 2);
    for (const [keyword, pages] of titleConflicts) {
      if (this.isSignificantKeyword(keyword)) {
        issues.push({
          message: `Multiple pages targeting keyword: "${keyword}"`,
          detail: `${pages.length} pages have this keyword in title: ${pages.slice(0, 3).map(p => `<a href="${p.url}">${this.shortenUrl(p.url)}</a>`).join(', ')}${pages.length > 3 ? ` (+${pages.length - 3} more)` : ''}`,
          severity: pages.length > 3 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
        });
      }
    }

    // Find cannibalisation in H1s
    const h1Conflicts = this.findConflicts(h1Keywords, 2);
    for (const [keyword, pages] of h1Conflicts) {
      if (this.isSignificantKeyword(keyword) && !titleConflicts.has(keyword)) {
        warnings.push({
          message: `Multiple pages with similar H1 keyword: "${keyword}"`,
          detail: `${pages.length} pages target this in H1: ${pages.slice(0, 3).map(p => `<a href="${p.url}">${this.shortenUrl(p.url)}</a>`).join(', ')}`,
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
        detail: `These pages have very similar titles: ${group.map(p => `<a href="${p.url}">"${this.truncate(p.title, 40)}"</a>`).join(', ')}`,
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
  static extractKeywords(text) {
    if (!text) return [];

    // Normalize text
    const normalized = text.toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Extract 2-4 word phrases
    const words = normalized.split(' ').filter(w => w.length > 2);
    const keywords = new Set();

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
  static extractTopic(url, page) {
    try {
      const parsed = new URL(url);
      const pathParts = parsed.pathname.split('/').filter(p => p.length > 0);

      // Use first meaningful path segment as topic
      for (const part of pathParts) {
        const normalized = part
          .replace(/[-_]/g, ' ')
          .replace(/\d+/g, '')
          .trim()
          .toLowerCase();

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
  static findConflicts(keywordMap, minCount) {
    const conflicts = new Map();

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
  static isSignificantKeyword(keyword) {
    // Must be at least 2 words or 6+ chars
    const words = keyword.split(' ');
    if (words.length >= 2) return true;
    if (keyword.length >= 6) return true;
    return false;
  }

  /**
   * Find near-duplicate titles using similarity
   */
  static findNearDuplicateTitles(pages) {
    const groups = [];
    const processed = new Set();
    const pageList = Object.entries(pages)
      .filter(([_, p]) => p.status === 200 && p.title)
      .map(([url, p]) => ({ url, title: p.title }));

    for (let i = 0; i < pageList.length; i++) {
      if (processed.has(pageList[i].url)) continue;

      const group = [pageList[i]];
      const baseTitle = this.normalizeForComparison(pageList[i].title);

      for (let j = i + 1; j < pageList.length; j++) {
        if (processed.has(pageList[j].url)) continue;

        const compareTitle = this.normalizeForComparison(pageList[j].title);
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
  static normalizeForComparison(title) {
    return title
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(w => !this.isStopword(w))
      .join(' ');
  }

  /**
   * Calculate Jaccard similarity between two strings
   */
  static calculateSimilarity(str1, str2) {
    const set1 = new Set(str1.split(' '));
    const set2 = new Set(str2.split(' '));

    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    return intersection.size / union.size;
  }

  /**
   * Check if word is a stopword
   */
  static isStopword(word) {
    return STOPWORDS.has(word.toLowerCase());
  }

  /**
   * Shorten URL for display
   */
  static shortenUrl(url) {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path.length > 40) {
        return '...' + path.slice(-37);
      }
      return path || '/';
    } catch {
      return url.slice(-40);
    }
  }

  /**
   * Truncate text
   */
  static truncate(text, length) {
    if (!text) return '';
    if (text.length <= length) return text;
    return text.slice(0, length - 3) + '...';
  }
}

module.exports = { KeywordCannibalisationAnalyzer };
