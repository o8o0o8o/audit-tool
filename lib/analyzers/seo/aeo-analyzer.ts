/**
 * AEO (Answer Engine Optimization) / AI Search Readiness Analyzer
 * Checks if a site is optimized for AI-powered search engines
 * (ChatGPT, Claude, Perplexity, Google AI Overviews)
 */

import { SEVERITY } from '../../constants';
import { detectAuthorInfo, calcPercent } from '../../utils';
import type { ParsedPage, ChromePage, Issue, PageInfo, AeoData } from '../../types';

interface AeoInfo extends AeoData {
  hasFAQSchema?: boolean;
  hasHowToSchema?: boolean;
  hasContentLists?: boolean;
  hasStructuredTables?: boolean;
  hasBlockquotes?: boolean;
}

interface AiCrawlerRule {
  owner: string;
  hasRules: boolean;
  blocked: boolean;
  rules?: { allow: string[]; disallow: string[] };
  fallbackToWildcard?: boolean;
}

interface RobotsDataInput {
  userAgents?: Record<string, { allow: string[]; disallow: string[] }>;
}

export interface LlmsTxtResult {
  hasLlmsTxt: boolean;
  hasLlmsFullTxt: boolean;
  llmsTxtSize: number;
  llmsTxtValid: boolean;
  llmsTxtContent: string | null;
  status: 'valid' | 'invalid' | 'missing' | 'server-error';
  problems: string[];
}

/** An llms.txt needs a `# ` title and at least one Markdown link (`[text](url)`); bare URLs do not count. */
export function validateLlmsTxt(content: string): Pick<LlmsTxtResult, 'llmsTxtValid' | 'status' | 'problems'> {
  const problems: string[] = [];
  if (!/^#\s+.+/m.test(content)) problems.push('no # title heading');
  if (!/\[[^\]]+\]\([^)\s]+\)/.test(content)) problems.push('no Markdown links');
  const valid = problems.length === 0;
  return { llmsTxtValid: valid, status: valid ? 'valid' : 'invalid', problems };
}

// AI crawler user-agents to check in robots.txt
const AI_CRAWLERS = [
  { name: 'GPTBot', owner: 'OpenAI (ChatGPT)' },
  { name: 'ChatGPT-User', owner: 'OpenAI (ChatGPT browse)' },
  { name: 'Google-Extended', owner: 'Google (AI training)' },
  { name: 'ClaudeBot', owner: 'Anthropic (Claude)' },
  { name: 'Claude-Web', owner: 'Anthropic (Claude browse)' },
  { name: 'PerplexityBot', owner: 'Perplexity AI' },
  { name: 'Bytespider', owner: 'ByteDance (TikTok)' },
  { name: 'CCBot', owner: 'Common Crawl (AI training)' },
  { name: 'FacebookBot', owner: 'Meta AI' },
  { name: 'cohere-ai', owner: 'Cohere' },
  { name: 'Applebot-Extended', owner: 'Apple (AI features)' },
];

// Semantic HTML elements that help AI understand structure
const SEMANTIC_ELEMENTS = [
  'article',
  'section',
  'nav',
  'aside',
  'header',
  'footer',
  'main',
  'figure',
  'figcaption',
  'details',
  'summary',
  'time',
  'mark',
  'address',
];

// Generic container elements
const GENERIC_ELEMENTS = ['div', 'span'];

// FAQ-like patterns that are valuable for AI extraction
const FAQ_PATTERNS = [/(?:faq|frequently\s+asked|questions?\s+and\s+answers?)/i, /(?:q\s*&\s*a|q:\s|a:\s)/i];

class AEOAnalyzer {
  /**
   * Analyze a page for AI search readiness
   * @param {Object} chromePage - Playwright page object
   * @param {Object} parsedPage - Parsed HTML page
   * @param {string} url - Page URL
   * @returns {Object} Analysis results
   */
  static async analyze(chromePage: ChromePage, parsedPage: ParsedPage, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: AeoInfo = {
      semanticHTMLRatio: 0,
      semanticElements: {},
      genericElements: 0,
      totalElements: 0,
      hasFAQContent: false,
      hasDefinitionLists: false,
      hasStructuredQA: false,
      hasClearHeadingHierarchy: false,
      contentStructureScore: 0,
      hasCitableContent: false,
      hasDatetimeMarkup: false,
      hasAuthorInfo: false,
    };

    if (!parsedPage) {
      return { issues, warnings, info };
    }

    // 1. Semantic HTML ratio
    this.#analyzeSemanticHTML(parsedPage, info, issues, warnings, url);

    // 2. Content structure for AI extraction
    this.#analyzeContentStructure(parsedPage, info, warnings, url);

    // 3. FAQ and Q&A content detection
    this.#analyzeFAQContent(parsedPage, info);

    // 4. Citation-friendly signals
    this.#analyzeCitationSignals(parsedPage, info, warnings, url);

    // 5. Datetime markup
    this.#analyzeDatetimeMarkup(parsedPage, info);

    // 6. Calculate content structure score
    info.contentStructureScore = this.#calculateContentScore(info);

    return { issues, warnings, info };
  }

  /**
   * Analyze semantic HTML usage
   * @private
   */
  static #analyzeSemanticHTML(parsedPage: ParsedPage, info: AeoInfo, issues: Issue[], warnings: Issue[], url: string) {
    let semanticCount = 0;
    let genericCount = 0;

    for (const tag of SEMANTIC_ELEMENTS) {
      const elements = parsedPage.querySelectorAll(tag);
      if (elements.length > 0) {
        info.semanticElements[tag] = elements.length;
        semanticCount += elements.length;
      }
    }

    for (const tag of GENERIC_ELEMENTS) {
      genericCount += parsedPage.querySelectorAll(tag).length;
    }

    info.totalElements = semanticCount + genericCount;
    info.genericElements = genericCount;
    info.semanticHTMLRatio = calcPercent(semanticCount, info.totalElements);

    // Check for missing key semantic elements
    if (!info.semanticElements.main) {
      warnings.push({
        message: 'Missing <main> element',
        detail: `<a href="${url}">${url}</a> has no <main> landmark. AI crawlers use semantic landmarks to identify primary content.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (!info.semanticElements.article && !info.semanticElements.section) {
      warnings.push({
        message: 'No <article> or <section> elements',
        detail: `<a href="${url}">${url}</a> uses no semantic content sectioning. This makes it harder for AI to extract structured content.`,
        severity: SEVERITY.LOW,
      });
    }

    if (info.semanticHTMLRatio < 10 && info.totalElements > 50) {
      warnings.push({
        message: 'Low semantic HTML usage',
        detail: `<a href="${url}">${url}</a> has only ${info.semanticHTMLRatio}% semantic elements (${semanticCount} semantic vs ${genericCount} generic). Higher semantic HTML helps AI understand page structure.`,
        severity: SEVERITY.LOW,
      });
    }
  }

  /**
   * Analyze content structure for AI extraction
   * @private
   */
  static #analyzeContentStructure(parsedPage: ParsedPage, info: AeoInfo, _warnings: Issue[], _url: string) {
    // Check heading hierarchy
    const headings: { level: number; text: string }[] = [];
    for (let i = 1; i <= 6; i++) {
      const hs = parsedPage.querySelectorAll(`h${i}`);
      for (const h of hs) {
        headings.push({ level: i, text: h.textContent?.trim() || '' });
      }
    }

    // Verify clean hierarchy (no skipping levels)
    if (headings.length > 0) {
      let prevLevel = 0;
      let isClean = true;
      for (const h of headings) {
        if (h.level > prevLevel + 1 && prevLevel > 0) {
          isClean = false;
          break;
        }
        prevLevel = h.level;
      }
      info.hasClearHeadingHierarchy = isClean;
    }

    // Check for definition lists (good for AI term extraction)
    const dlElements = parsedPage.querySelectorAll('dl');
    info.hasDefinitionLists = dlElements.length > 0;

    // Check for ordered/unordered lists with content (good for step-by-step)
    const lists = parsedPage.querySelectorAll('ol, ul');
    const contentLists = Array.from(lists).filter((list) => {
      const items = list.querySelectorAll('li');
      return items.length >= 3;
    });

    info.hasContentLists = contentLists.length > 0;

    // Check for tables with headers (good for structured data extraction)
    const tables = parsedPage.querySelectorAll('table');
    info.hasStructuredTables = Array.from(tables).some((table) => table.querySelector('th') !== null);
  }

  /**
   * Analyze FAQ and Q&A content patterns
   * @private
   */
  static #analyzeFAQContent(parsedPage: ParsedPage, info: AeoInfo) {
    const html = parsedPage.toString();

    // Check for FAQ schema
    info.hasFAQSchema = html.includes('FAQPage') || html.includes('QAPage');

    // Check for FAQ-like content patterns
    info.hasFAQContent = FAQ_PATTERNS.some((pattern) => pattern.test(html));

    // Check for structured Q&A (details/summary or similar patterns)
    const detailsElements = parsedPage.querySelectorAll('details');
    info.hasStructuredQA = detailsElements.length >= 2;

    // Check for HowTo schema
    info.hasHowToSchema = html.includes('HowTo');
  }

  /**
   * Analyze citation-friendly signals
   * @private
   */
  static #analyzeCitationSignals(parsedPage: ParsedPage, info: AeoInfo, _warnings: Issue[], _url: string) {
    // Check for author info (uses shared utility)
    const authorResult = detectAuthorInfo(parsedPage);
    info.hasAuthorInfo = authorResult.author !== null;

    // Check for clear, concise introductory content (first paragraph)
    const firstParagraph = parsedPage.querySelector('article p, main p, .content p');
    if (firstParagraph) {
      const text = firstParagraph.textContent?.trim() || '';
      // A good intro paragraph is 50-300 chars - concise and quotable
      info.hasCitableContent = text.length >= 50 && text.length <= 500;
    }

    // Check for blockquotes or highlighted content
    const blockquotes = parsedPage.querySelectorAll('blockquote');
    info.hasBlockquotes = blockquotes.length > 0;
  }

  /**
   * Analyze datetime markup
   * @private
   */
  static #analyzeDatetimeMarkup(parsedPage: ParsedPage, info: AeoInfo) {
    const timeElements = parsedPage.querySelectorAll('time[datetime]');
    const dateMeta = parsedPage.querySelector(
      'meta[property="article:published_time"], meta[property="article:modified_time"]',
    );

    info.hasDatetimeMarkup = timeElements.length > 0 || !!dateMeta;
  }

  /**
   * Calculate overall content structure score (0-100)
   * @private
   */
  static #calculateContentScore(info: AeoInfo) {
    let score = 0;

    // Semantic HTML (up to 20 points)
    if (info.semanticHTMLRatio >= 20) score += 20;
    else if (info.semanticHTMLRatio >= 10) score += 10;
    else if (info.semanticHTMLRatio > 0) score += 5;

    // Key semantic elements (up to 15 points)
    if (info.semanticElements.main) score += 5;
    if (info.semanticElements.article) score += 5;
    if (info.semanticElements.nav) score += 5;

    // Content structure (up to 25 points)
    if (info.hasClearHeadingHierarchy) score += 10;
    if (info.hasContentLists) score += 5;
    if (info.hasStructuredTables) score += 5;
    if (info.hasDefinitionLists) score += 5;

    // FAQ/QA content (up to 15 points)
    if (info.hasFAQSchema) score += 10;
    else if (info.hasFAQContent || info.hasStructuredQA) score += 5;
    if (info.hasHowToSchema) score += 5;

    // Citation signals (up to 25 points)
    if (info.hasAuthorInfo) score += 10;
    if (info.hasCitableContent) score += 5;
    if (info.hasDatetimeMarkup) score += 10;

    return Math.min(100, score);
  }

  /**
   * Analyze robots.txt for AI crawler rules
   * @param {Object} robotsData - Parsed robots.txt data
   * @param {string} origin - Site origin
   * @returns {Object} AI crawler analysis
   */
  static analyzeRobotsTxt(robotsData: RobotsDataInput, _origin: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info = {
      aiCrawlerRules: {} as Record<string, AiCrawlerRule>,
      blockedCrawlers: [] as string[],
      allowedCrawlers: [] as string[],
      noCrawlerRules: [] as string[],
    };

    if (!robotsData?.userAgents) {
      return { issues, warnings, info };
    }

    const wildcardRules = robotsData.userAgents['*'];

    for (const crawler of AI_CRAWLERS) {
      const rules = robotsData.userAgents[crawler.name];

      if (rules) {
        // Crawler has specific rules
        const isBlocked = rules.disallow.includes('/');
        const hasAllowOverride = rules.allow.includes('/');

        info.aiCrawlerRules[crawler.name] = {
          owner: crawler.owner,
          hasRules: true,
          blocked: isBlocked && !hasAllowOverride,
          rules,
        };

        if (isBlocked && !hasAllowOverride) {
          info.blockedCrawlers.push(crawler.name);
        } else {
          info.allowedCrawlers.push(crawler.name);
        }
      } else if (wildcardRules) {
        // No specific rules - falls back to wildcard
        const blockedByWildcard = wildcardRules.disallow.includes('/');
        info.aiCrawlerRules[crawler.name] = {
          owner: crawler.owner,
          hasRules: false,
          blocked: blockedByWildcard,
          fallbackToWildcard: true,
        };

        if (blockedByWildcard) {
          info.blockedCrawlers.push(crawler.name);
        } else {
          info.noCrawlerRules.push(crawler.name);
        }
      } else {
        info.aiCrawlerRules[crawler.name] = {
          owner: crawler.owner,
          hasRules: false,
          blocked: false,
        };
        info.noCrawlerRules.push(crawler.name);
      }
    }

    // Report blocked AI crawlers
    if (info.blockedCrawlers.length > 0) {
      const crawlerList = info.blockedCrawlers
        .map((name: string) => {
          const c = AI_CRAWLERS.find((c) => c.name === name);
          return `${name} (${c?.owner ?? 'unknown'})`;
        })
        .join(', ');

      warnings.push({
        message: `AI crawlers blocked in robots.txt`,
        detail: `The following AI crawlers are blocked: ${crawlerList}. Blocking AI crawlers reduces visibility in AI-powered search engines like ChatGPT, Perplexity, and Google AI Overviews.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Info about no explicit rules
    if (info.noCrawlerRules.length === AI_CRAWLERS.length) {
      warnings.push({
        message: 'No explicit AI crawler rules in robots.txt',
        detail: `No specific rules for AI crawlers (GPTBot, ClaudeBot, PerplexityBot, etc.). Consider adding explicit Allow/Disallow rules to control AI access.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }

  /**
   * Check for llms.txt file
   * @param {string} origin - Site origin
   * @returns {Promise<Object>} llms.txt analysis
   */
  static async analyzeLlmsTxt(origin: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: LlmsTxtResult = {
      hasLlmsTxt: false,
      hasLlmsFullTxt: false,
      llmsTxtSize: 0,
      llmsTxtValid: false,
      llmsTxtContent: null,
      status: 'missing',
      problems: [],
    };

    let llmsTxtFetched = false;
    try {
      const response = await fetch(`${origin}/llms.txt`, {
        signal: AbortSignal.timeout(10000),
      });

      llmsTxtFetched = true;
      const contentType = response.headers.get('content-type') ?? '';
      if (response.status >= 500) {
        info.status = 'server-error';
      } else if (response.ok && contentType.includes('text/')) {
        info.hasLlmsTxt = true;
        const content = await response.text();
        info.llmsTxtSize = content.length;
        Object.assign(info, validateLlmsTxt(content));
      }

      const fullResponse = await fetch(`${origin}/llms-full.txt`, {
        signal: AbortSignal.timeout(10000),
      });
      const fullContentType = fullResponse.headers.get('content-type') ?? '';
      if (fullResponse.ok && fullContentType.includes('text/')) {
        info.hasLlmsFullTxt = true;
      }
    } catch {
      // Network error or timeout. If llms.txt itself never answered, its absence is unproven.
      if (!llmsTxtFetched) info.status = 'server-error';
    }

    // llms.txt findings are reported by the agentic browsing family, not as AEO issues.
    return { issues, warnings, info };
  }

  /**
   * Site-wide AEO analysis
   * @param {Object} pages - All pages
   * @returns {Object} Analysis results
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    let totalSemanticRatio = 0;
    let totalContentScore = 0;
    let pagesWithFAQ = 0;
    let pagesWithAuthor = 0;
    let pagesWithDatetime = 0;
    let pagesWithMain = 0;
    let pagesAnalyzed = 0;

    for (const [_url, page] of Object.entries(pages)) {
      if (!page.aeo) continue;
      pagesAnalyzed++;

      totalSemanticRatio += page.aeo.semanticHTMLRatio || 0;
      totalContentScore += page.aeo.contentStructureScore || 0;

      if (page.aeo.hasFAQContent || page.aeo.hasFAQSchema) pagesWithFAQ++;
      if (page.aeo.hasAuthorInfo) pagesWithAuthor++;
      if (page.aeo.hasDatetimeMarkup) pagesWithDatetime++;
      if (page.aeo.semanticElements?.main) pagesWithMain++;
    }

    if (pagesAnalyzed === 0) {
      return { issues, warnings, stats: {} };
    }

    const avgSemanticRatio = Math.round(totalSemanticRatio / pagesAnalyzed);
    const avgContentScore = Math.round(totalContentScore / pagesAnalyzed);

    // Low average semantic HTML usage
    if (avgSemanticRatio < 10) {
      issues.push({
        message: 'Site-wide low semantic HTML usage for AI readiness',
        detail: `Average semantic HTML ratio is ${avgSemanticRatio}% across ${pagesAnalyzed} pages. Use semantic elements (<main>, <article>, <section>, <nav>) to help AI crawlers understand page structure.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Low content structure score
    if (avgContentScore < 30) {
      warnings.push({
        message: 'Low AI content structure score',
        detail: `Average AI readiness score is ${avgContentScore}/100. Improve by adding structured content (FAQ schema, clear headings, author info, date markup).`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Missing author info on most pages
    if (pagesWithAuthor < pagesAnalyzed * 0.3) {
      warnings.push({
        message: 'Most pages lack author attribution',
        detail: `Only ${pagesWithAuthor}/${pagesAnalyzed} pages have author information. Author attribution helps AI assess content credibility and is important for E-E-A-T.`,
        severity: SEVERITY.LOW,
      });
    }

    // Missing datetime on most pages
    if (pagesWithDatetime < pagesAnalyzed * 0.3) {
      warnings.push({
        message: 'Most pages lack date markup',
        detail: `Only ${pagesWithDatetime}/${pagesAnalyzed} pages have datetime markup. AI models use dates to assess content freshness.`,
        severity: SEVERITY.LOW,
      });
    }

    // Missing <main> element
    if (pagesWithMain < pagesAnalyzed * 0.5) {
      warnings.push({
        message: 'Many pages missing <main> landmark',
        detail: `Only ${pagesWithMain}/${pagesAnalyzed} pages use <main>. This landmark helps AI crawlers identify primary content.`,
        severity: SEVERITY.LOW,
      });
    }

    return {
      issues,
      warnings,
      stats: {
        pagesAnalyzed,
        avgSemanticRatio,
        avgContentScore,
        pagesWithFAQ,
        pagesWithAuthor,
        pagesWithDatetime,
        pagesWithMain,
      },
    };
  }
}

export { AEOAnalyzer };
