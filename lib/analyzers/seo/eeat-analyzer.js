/**
 * E-E-A-T Signals Analyzer
 * Analyzes Experience, Expertise, Authoritativeness, and Trustworthiness signals
 */

const { SEVERITY } = require('../../constants');

class EEATAnalyzer {
  /**
   * Analyze E-E-A-T signals on a page
   * @param {Object} parsedPage - Parsed HTML page
   * @param {string} url - Page URL
   * @param {Object} pageData - Page data object
   * @returns {Object} Analysis results
   */
  static analyze(parsedPage, url, pageData) {
    const issues = [];
    const warnings = [];
    const signals = {
      author: null,
      authorCredentials: [],
      publishDate: null,
      updateDate: null,
      hasAboutPage: false,
      hasContactInfo: false,
      hasPrivacyPolicy: false,
      hasTermsOfService: false,
      trustSignals: [],
      expertiseSignals: [],
      score: 0,
    };

    if (!parsedPage) {
      return { issues, warnings, signals };
    }

    // 1. Author Detection
    const authorResult = this.detectAuthor(parsedPage);
    signals.author = authorResult.author;
    signals.authorCredentials = authorResult.credentials;

    if (!authorResult.author && this.isContentPage(url, parsedPage)) {
      warnings.push({
        message: 'No author information found',
        detail: `Content pages should have clear author attribution for E-E-A-T. Consider adding author byline or schema.`,
        severity: SEVERITY.LOW,
      });
    }

    // 2. Date Information
    const dateResult = this.detectDates(parsedPage, pageData);
    signals.publishDate = dateResult.publishDate;
    signals.updateDate = dateResult.updateDate;

    // 3. Trust Signals
    signals.trustSignals = this.detectTrustSignals(parsedPage);

    // 4. Expertise Signals
    signals.expertiseSignals = this.detectExpertiseSignals(parsedPage);

    // 5. Check for important pages (via links)
    const linkAnalysis = this.analyzeImportantLinks(parsedPage);
    signals.hasAboutPage = linkAnalysis.hasAboutPage;
    signals.hasContactInfo = linkAnalysis.hasContactInfo;
    signals.hasPrivacyPolicy = linkAnalysis.hasPrivacyPolicy;
    signals.hasTermsOfService = linkAnalysis.hasTermsOfService;

    // 6. YMYL Detection (Your Money Your Life)
    const isYMYL = this.detectYMYL(url, parsedPage);
    if (isYMYL) {
      signals.isYMYL = true;

      // YMYL pages need stronger E-E-A-T signals
      if (!signals.author) {
        issues.push({
          message: 'YMYL page without author attribution',
          detail: `This appears to be a YMYL (Your Money Your Life) page. Google requires strong E-E-A-T signals for such content.`,
          severity: SEVERITY.MEDIUM,
        });
      }

      if (signals.trustSignals.length === 0) {
        issues.push({
          message: 'YMYL page lacks trust signals',
          detail: `YMYL pages should display trust indicators (certifications, credentials, testimonials, etc.)`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // 7. Calculate E-E-A-T Score
    signals.score = this.calculateScore(signals);

    // Store in pageData
    pageData.eeat = signals;

    return { issues, warnings, signals };
  }

  /**
   * Detect author information
   */
  static detectAuthor(parsedPage) {
    const result = { author: null, credentials: [] };

    // Check schema.org author
    const scripts = parsedPage.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const schemas = Array.isArray(data) ? data : [data];
        for (const schema of schemas) {
          if (schema.author) {
            const author = typeof schema.author === 'string'
              ? schema.author
              : schema.author.name;
            if (author) {
              result.author = author;
              if (schema.author.jobTitle) {
                result.credentials.push(schema.author.jobTitle);
              }
              if (schema.author.description) {
                result.credentials.push(schema.author.description);
              }
            }
          }
        }
      } catch (e) {
        // JSON parsing failed - script contains invalid JSON-LD, skip silently
        // This is expected for malformed structured data
      }
    }

    // Check meta author
    if (!result.author) {
      const metaAuthor = parsedPage.querySelector('meta[name="author"]');
      if (metaAuthor) {
        result.author = metaAuthor.getAttribute('content');
      }
    }

    // Check common author patterns in HTML
    if (!result.author) {
      const authorSelectors = [
        '[rel="author"]',
        '.author-name',
        '.author',
        '.byline',
        '[itemprop="author"]',
        '.post-author',
        '.article-author',
        '.entry-author',
      ];

      for (const selector of authorSelectors) {
        const el = parsedPage.querySelector(selector);
        if (el) {
          const text = el.textContent.trim();
          if (text && text.length < 100) {
            result.author = text.replace(/^by\s+/i, '');
            break;
          }
        }
      }
    }

    // Look for credentials near author
    if (result.author) {
      const credentialPatterns = [
        /\b(MD|PhD|Dr\.|M\.D\.|DO|JD|MBA|CPA|CFP|RN|LCSW)\b/gi,
        /\b(certified|licensed|registered|board-certified)\s+\w+/gi,
        /\b(\d+)\+?\s*years?\s*(of)?\s*experience/gi,
      ];

      const bodyText = parsedPage.text || '';
      for (const pattern of credentialPatterns) {
        const matches = bodyText.match(pattern);
        if (matches) {
          result.credentials.push(...matches.slice(0, 3));
        }
      }
    }

    return result;
  }

  /**
   * Detect publish and update dates
   */
  static detectDates(parsedPage, pageData) {
    const result = { publishDate: null, updateDate: null };

    // Check if already in pageData from freshness analyzer
    if (pageData.freshnessData) {
      result.publishDate = pageData.freshnessData.datePublished;
      result.updateDate = pageData.freshnessData.dateModified;
    }

    // Check time elements
    if (!result.publishDate) {
      const timeEl = parsedPage.querySelector('time[datetime]');
      if (timeEl) {
        result.publishDate = timeEl.getAttribute('datetime');
      }
    }

    return result;
  }

  /**
   * Detect trust signals
   */
  static detectTrustSignals(parsedPage) {
    const signals = [];
    const bodyText = (parsedPage.text || '').toLowerCase();
    const html = parsedPage.toString().toLowerCase();

    // Security badges
    const securityPatterns = [
      { pattern: /ssl|https|secure/i, signal: 'Security mentioned' },
      { pattern: /norton|mcafee|trustwave|verisign/i, signal: 'Security certification' },
    ];

    // Trust badges
    const trustPatterns = [
      { pattern: /bbb|better business bureau/i, signal: 'BBB accredited' },
      { pattern: /trustpilot|reviews?\.io|google reviews/i, signal: 'Review platform' },
      { pattern: /money.back.guarantee|satisfaction.guarantee/i, signal: 'Guarantee offered' },
      { pattern: /verified|certified|accredited/i, signal: 'Verification badge' },
    ];

    // Industry certifications
    const certPatterns = [
      { pattern: /hipaa|gdpr|pci.dss|soc.2/i, signal: 'Compliance certification' },
      { pattern: /iso.\d+|iso.certified/i, signal: 'ISO certification' },
    ];

    // Social proof
    const socialProofPatterns = [
      { pattern: /(\d+[,.]?\d*)\s*(customers?|clients?|users?)/i, signal: 'Customer count' },
      { pattern: /as\s+seen\s+(in|on)/i, signal: 'Media mentions' },
      { pattern: /featured\s+(in|on|by)/i, signal: 'Featured mentions' },
      { pattern: /award|winner|recognized/i, signal: 'Awards/Recognition' },
    ];

    const allPatterns = [...securityPatterns, ...trustPatterns, ...certPatterns, ...socialProofPatterns];

    for (const { pattern, signal } of allPatterns) {
      if (pattern.test(bodyText) || pattern.test(html)) {
        signals.push(signal);
      }
    }

    return [...new Set(signals)]; // Dedupe
  }

  /**
   * Detect expertise signals
   */
  static detectExpertiseSignals(parsedPage) {
    const signals = [];
    const bodyText = (parsedPage.text || '').toLowerCase();

    const expertisePatterns = [
      { pattern: /expert|specialist|professional/i, signal: 'Expert positioning' },
      { pattern: /(\d+)\+?\s*years?\s*(of)?\s*experience/i, signal: 'Years of experience' },
      { pattern: /case\s+stud(y|ies)/i, signal: 'Case studies' },
      { pattern: /research|study|data|statistics/i, signal: 'Research/Data referenced' },
      { pattern: /peer.review|journal|publication/i, signal: 'Academic references' },
      { pattern: /interview|quote|according to/i, signal: 'Expert quotes' },
      { pattern: /methodology|process|approach/i, signal: 'Methodology explained' },
      { pattern: /sources?:|references?:|cited/i, signal: 'Sources cited' },
    ];

    for (const { pattern, signal } of expertisePatterns) {
      if (pattern.test(bodyText)) {
        signals.push(signal);
      }
    }

    // Check for citations/references section
    const citationSelectors = ['#references', '#citations', '#sources', '.references', '.citations'];
    for (const selector of citationSelectors) {
      if (parsedPage.querySelector(selector)) {
        signals.push('References section');
        break;
      }
    }

    return [...new Set(signals)];
  }

  /**
   * Analyze important page links
   */
  static analyzeImportantLinks(parsedPage) {
    const links = parsedPage.querySelectorAll('a');
    const result = {
      hasAboutPage: false,
      hasContactInfo: false,
      hasPrivacyPolicy: false,
      hasTermsOfService: false,
    };

    for (const link of links) {
      const href = (link.getAttribute('href') || '').toLowerCase();
      const text = (link.textContent || '').toLowerCase();

      if (/about|who.we.are|our.team|our.story/i.test(href) || /about|who we are/i.test(text)) {
        result.hasAboutPage = true;
      }
      if (/contact|get.in.touch/i.test(href) || /contact/i.test(text)) {
        result.hasContactInfo = true;
      }
      if (/privacy/i.test(href) || /privacy/i.test(text)) {
        result.hasPrivacyPolicy = true;
      }
      if (/terms|tos|conditions/i.test(href) || /terms/i.test(text)) {
        result.hasTermsOfService = true;
      }
    }

    // Also check for contact info in content
    const bodyText = parsedPage.text || '';
    if (/\b[\w.-]+@[\w.-]+\.\w{2,}\b/.test(bodyText)) {
      result.hasContactInfo = true;
    }
    if (/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(bodyText)) {
      result.hasContactInfo = true;
    }

    return result;
  }

  /**
   * Detect if page is YMYL (Your Money Your Life)
   */
  static detectYMYL(url, parsedPage) {
    const urlLower = url.toLowerCase();
    const bodyText = (parsedPage.text || '').toLowerCase();

    // URL patterns
    const ymylUrlPatterns = [
      /health|medical|medicine|doctor|hospital|symptom|disease|treatment/i,
      /finance|banking|invest|insurance|tax|credit|loan|mortgage/i,
      /legal|lawyer|attorney|law|court/i,
      /news|government|voting|election|civic/i,
      /safety|emergency|disaster/i,
    ];

    for (const pattern of ymylUrlPatterns) {
      if (pattern.test(urlLower)) {
        return true;
      }
    }

    // Content patterns (check density)
    const ymylContentPatterns = [
      { pattern: /medical advice|health advice|consult.*doctor/gi, weight: 3 },
      { pattern: /financial advice|investment advice|tax advice/gi, weight: 3 },
      { pattern: /legal advice|attorney|lawsuit/gi, weight: 3 },
      { pattern: /prescription|medication|dosage|side effects/gi, weight: 2 },
      { pattern: /credit score|mortgage rate|interest rate/gi, weight: 2 },
      { pattern: /symptoms?|diagnosis|treatment plan/gi, weight: 2 },
    ];

    let ymylScore = 0;
    for (const { pattern, weight } of ymylContentPatterns) {
      const matches = bodyText.match(pattern);
      if (matches) {
        ymylScore += matches.length * weight;
      }
    }

    return ymylScore >= 5;
  }

  /**
   * Check if page is a content page (not homepage, category, etc.)
   */
  static isContentPage(url, parsedPage) {
    const urlLower = url.toLowerCase();

    // Likely not content pages
    if (/\/(home|index|category|tag|archive|search|cart|checkout|account|login)/i.test(urlLower)) {
      return false;
    }

    // Check for article indicators
    const hasArticle = parsedPage.querySelector('article') !== null;
    const hasBlogPost = parsedPage.querySelector('.post, .blog-post, .entry') !== null;
    const hasLongContent = (parsedPage.text || '').split(/\s+/).length > 300;

    return hasArticle || hasBlogPost || hasLongContent;
  }

  /**
   * Calculate E-E-A-T score (0-100)
   */
  static calculateScore(signals) {
    let score = 30; // Base score

    // Author (+20)
    if (signals.author) {
      score += 10;
      if (signals.authorCredentials.length > 0) {
        score += 10;
      }
    }

    // Dates (+10)
    if (signals.publishDate) score += 5;
    if (signals.updateDate) score += 5;

    // Trust signals (+20)
    score += Math.min(signals.trustSignals.length * 5, 20);

    // Expertise signals (+10)
    score += Math.min(signals.expertiseSignals.length * 3, 10);

    // Important pages (+10)
    if (signals.hasAboutPage) score += 3;
    if (signals.hasContactInfo) score += 3;
    if (signals.hasPrivacyPolicy) score += 2;
    if (signals.hasTermsOfService) score += 2;

    return Math.min(score, 100);
  }

  /**
   * Site-wide E-E-A-T analysis
   */
  static analyzeSiteWide(pages) {
    const issues = [];
    const warnings = [];

    let totalScore = 0;
    let pagesWithAuthor = 0;
    let contentPages = 0;
    let ymylPages = 0;
    let ymylWithoutAuthor = 0;

    for (const [url, page] of Object.entries(pages)) {
      if (page.eeat) {
        totalScore += page.eeat.score;

        if (page.eeat.author) pagesWithAuthor++;
        if (page.eeat.isYMYL) {
          ymylPages++;
          if (!page.eeat.author) ymylWithoutAuthor++;
        }
      }
      contentPages++;
    }

    const avgScore = contentPages > 0 ? totalScore / contentPages : 0;
    const authorPercent = contentPages > 0 ? (pagesWithAuthor / contentPages) * 100 : 0;

    if (avgScore < 50) {
      issues.push({
        message: 'Low E-E-A-T signals across site',
        detail: `Average E-E-A-T score is ${avgScore.toFixed(0)}/100. Consider adding author information, trust signals, and expertise indicators.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (authorPercent < 30 && contentPages > 5) {
      warnings.push({
        message: 'Most content pages lack author attribution',
        detail: `Only ${authorPercent.toFixed(1)}% of pages have author information. Adding author bylines can improve E-E-A-T.`,
        severity: SEVERITY.LOW,
      });
    }

    if (ymylWithoutAuthor > 0) {
      issues.push({
        message: `${ymylWithoutAuthor} YMYL pages without author attribution`,
        detail: `YMYL (Your Money Your Life) pages require strong E-E-A-T signals including clear authorship.`,
        severity: SEVERITY.HIGH,
      });
    }

    return {
      issues,
      warnings,
      metrics: {
        averageScore: Math.round(avgScore),
        pagesWithAuthor,
        authorPercent: Math.round(authorPercent),
        ymylPages,
        ymylWithoutAuthor,
      },
    };
  }
}

module.exports = { EEATAnalyzer };
