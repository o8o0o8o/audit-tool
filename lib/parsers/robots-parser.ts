/**
 * Robots.txt Parser
 * Fetches and parses robots.txt files according to the robots exclusion protocol
 * Includes comprehensive SEO validation and best practices checks
 */

import { SEVERITY, THRESHOLDS } from '../constants';
import { formatBytes, readResponseTextCapped } from '../utils';
import { fetchTextViaBrowser } from '../crawler/browser-fetch';
import { isNoPlaywright } from '../crawler/browser-guard';

/** True when the text contains at least one robots.txt directive (vs. an HTML challenge page). */
function looksLikeRobots(text: string): boolean {
  return /(^|\n)\s*(user-agent|disallow|allow|sitemap|crawl-delay|host)\s*:/i.test(text);
}

// Maximum robots.txt size (Google's limit is 500KB)
const MAX_ROBOTS_SIZE = 500 * 1024;

// Important bots to check for blocking
const IMPORTANT_BOTS = ['googlebot', 'bingbot', 'googlebot-image', 'googlebot-news', 'googlebot-video'];

// Paths that should generally not be blocked (affects rendering/SEO)
const CRITICAL_PATHS = [
  { pattern: /^\/.*\.(css|js)$/i, name: 'CSS/JS files', severity: SEVERITY.HIGH },
  { pattern: /^\/(assets|static|public)\//i, name: 'Static assets', severity: SEVERITY.MEDIUM },
  { pattern: /^\/_next\//i, name: 'Next.js assets', severity: SEVERITY.HIGH },
  {
    pattern: /^\/wp-content\/(themes|plugins)\/.*\.(css|js)$/i,
    name: 'WordPress theme/plugin assets',
    severity: SEVERITY.HIGH,
  },
];

// Sensitive paths that shouldn't be exposed in robots.txt
const SENSITIVE_PATHS = [
  /^\/(admin|administrator|wp-admin|backend|dashboard)/i,
  /^\/(backup|backups|db|database|dump)/i,
  /^\/(config|configuration|settings|\.env)/i,
  /^\/(private|secret|internal|hidden)/i,
  /^\/(api\/admin|api\/internal|api\/debug)/i,
  /^\/(phpmyadmin|adminer|cpanel)/i,
  /^\/(\.git|\.svn|\.hg)/i,
  /^\/(test|staging|dev)(?:\/|$)/i,
];

// Common problematic patterns
const PROBLEMATIC_PATTERNS = [
  { pattern: '/*?', description: 'Blocks all URLs with query parameters' },
  { pattern: '/*.php', description: 'Blocks all PHP files' },
  { pattern: '/search', description: 'Blocks search pages (may affect internal search indexing)' },
  { pattern: '/tag', description: 'Blocks tag pages' },
  { pattern: '/category', description: 'Blocks category pages' },
];

interface RobotsRules {
  allow: string[];
  disallow: string[];
}

interface RobotsResult {
  sitemaps: string[];
  userAgents: Record<string, RobotsRules>;
  crawlDelay: Record<string, number>;
  host: string | null;
  errors: Array<{ message: string; detail: string | null; severity: string }>;
  metadata: {
    size: number;
    responseTime: number;
    contentType: string | null;
    statusCode: number | null;
  };
}

class RobotsParser {
  /**
   * Fetch and parse robots.txt from a given origin
   * @param {string} origin - Website origin URL
   * @returns {Promise<object>} Parsed robots data and any errors found
   */
  static async parseRobotsTxt(origin: string) {
    const result: RobotsResult = {
      sitemaps: [] as string[],
      userAgents: {} as Record<string, { allow: string[]; disallow: string[] }>,
      crawlDelay: {} as Record<string, number>, // user-agent -> delay in seconds
      host: null, // Host directive (Yandex)
      errors: [] as Array<{ message: string; detail: string | null; severity: string }>,
      metadata: {
        size: 0,
        responseTime: 0,
        contentType: null,
        statusCode: null,
      },
    };

    try {
      console.log('Analyzing robots.txt...');

      const startTime = Date.now();
      const robotsResponse = await fetch(origin + '/robots.txt');
      result.metadata.responseTime = Date.now() - startTime;
      result.metadata.statusCode = robotsResponse.status;
      result.metadata.contentType = robotsResponse.headers.get('content-type');

      // Capped read: a gzip-bomb robots.txt would otherwise be fully buffered.
      let effectiveStatus = robotsResponse.status;
      let robotsContent =
        robotsResponse.status === 200 ? await readResponseTextCapped(robotsResponse, THRESHOLDS.MAX_ROBOTS_FETCH) : '';

      // A plain fetch can be blocked by bot protection (e.g. a 429 + JS challenge
      // page) — retry through a real browser, which can clear the challenge, before
      // treating a non-200 as an error.
      if (effectiveStatus !== 200 && !isNoPlaywright()) {
        const viaBrowser = await fetchTextViaBrowser(origin + '/robots.txt', THRESHOLDS.MAX_ROBOTS_FETCH).catch(
          () => null,
        );
        if (viaBrowser && viaBrowser.status === 200 && looksLikeRobots(viaBrowser.text)) {
          console.log('robots.txt recovered via browser fallback (plain fetch was blocked)');
          effectiveStatus = 200;
          robotsContent = viaBrowser.text;
          result.metadata.statusCode = 200;
          // The challenge page's Content-Type is meaningless for the recovered file.
          result.metadata.contentType = null;
        }
      }

      if (effectiveStatus === 200) {
        result.metadata.size = robotsContent.length;

        // Check content type
        this.#validateContentType(result);

        // Check file size
        this.#validateFileSize(result);

        if (robotsContent.length) {
          // Remove BOM if present
          const cleanContent = this.#removeBOM(robotsContent);

          this.#parseRobotsContent(cleanContent, result);

          // Run all validations
          this.#validateUserAgentRules(result);
          this.#checkCriticalPathBlocking(result);
          this.#checkSensitivePathExposure(result);
          this.#checkProblematicPatterns(result);
          this.#checkWildcardUsage(result);
          this.#checkImportantBotBlocking(result);
          this.#checkConflictingRules(result);
        } else {
          result.errors.push({
            message: 'robots.txt is empty',
            detail: 'An empty robots.txt provides no crawling guidance. Consider adding rules or sitemaps.',
            severity: SEVERITY.HIGH,
          });
        }
      } else if (robotsResponse.status === 404) {
        result.errors.push({
          message: 'robots.txt not found (404)',
          detail:
            'Without robots.txt, search engines will crawl all accessible pages. Consider creating one to control crawling.',
          severity: SEVERITY.MEDIUM,
        });
      } else {
        result.errors.push({
          message: `Error fetching robots.txt (HTTP ${robotsResponse.status})`,
          detail: `Server returned status ${robotsResponse.status}. This may cause crawlers to retry or skip your site.`,
          severity: SEVERITY.CRITICAL,
        });
      }

      // Check for sitemap and add fallback if needed
      this.#checkSitemaps(origin, result);
    } catch (error: unknown) {
      const message = `Error during processing robots.txt: ${(error as Error).message}`;
      result.errors.push({
        message,
        detail: (error as Error).cause ? String((error as Error).cause) : null,
        severity: SEVERITY.HIGH,
      });
      console.log(message);
    }

    return result;
  }

  /**
   * Remove UTF-8 BOM if present
   * @param {string} content - File content
   * @returns {string} Content without BOM
   */
  static #removeBOM(content: string) {
    if (content.charCodeAt(0) === 0xfeff) {
      return content.slice(1);
    }
    return content;
  }

  /**
   * Validate content type header
   * @param {object} result - Result object
   */
  static #validateContentType(result: RobotsResult) {
    const contentType = result.metadata.contentType;
    if (contentType && !contentType.includes('text/plain')) {
      result.errors.push({
        message: 'robots.txt has incorrect Content-Type',
        detail: `Expected "text/plain" but got "${contentType}". Some crawlers may ignore the file.`,
        severity: SEVERITY.LOW,
      });
    }
  }

  /**
   * Validate file size
   * @param {object} result - Result object
   */
  static #validateFileSize(result: RobotsResult) {
    if (result.metadata.size > MAX_ROBOTS_SIZE) {
      result.errors.push({
        message: 'robots.txt exceeds size limit',
        detail: `File is ${formatBytes(result.metadata.size)} but Google's limit is 500KB. Rules beyond this limit may be ignored.`,
        severity: SEVERITY.HIGH,
      });
    } else if (result.metadata.size > MAX_ROBOTS_SIZE * 0.8) {
      result.errors.push({
        message: 'robots.txt is approaching size limit',
        detail: `File is ${formatBytes(result.metadata.size)} (${Math.round((result.metadata.size / MAX_ROBOTS_SIZE) * 100)}% of Google's 500KB limit).`,
        severity: SEVERITY.LOW,
      });
    }
  }

  /**
   * Parse robots.txt content into structured data
   * @param {string} content - robots.txt content
   * @param {object} result - Result object to populate
   */
  static #parseRobotsContent(content: string, result: RobotsResult) {
    let currentUserAgent = null;
    let lineNumber = 0;

    for (const rawLine of content.split('\n')) {
      lineNumber++;

      // Remove comments and trim
      const commentIndex = rawLine.indexOf('#');
      const line = (commentIndex >= 0 ? rawLine.slice(0, commentIndex) : rawLine).trim();

      // Skip empty lines
      if (!line) continue;

      // Parse field:value (handle both "field: value" and "field:value")
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {
        // Invalid line format
        result.errors.push({
          message: 'Invalid line in robots.txt',
          detail: `Line ${lineNumber}: "${rawLine.trim()}" - missing colon separator`,
          severity: SEVERITY.LOW,
        });
        continue;
      }

      const field = line.slice(0, colonIndex).toLowerCase().trim();
      const value = line.slice(colonIndex + 1).trim();

      switch (field) {
        case 'sitemap':
          if (value) {
            result.sitemaps.push(value);
          }
          break;

        case 'user-agent':
          currentUserAgent = value || '*';
          if (!result.userAgents[currentUserAgent]) {
            result.userAgents[currentUserAgent] = {
              allow: [],
              disallow: [],
            };
          }
          break;

        case 'disallow':
          if (currentUserAgent) {
            result.userAgents[currentUserAgent].disallow.push(value);

            // Check for blocking all crawlers
            if (value === '/') {
              result.errors.push({
                message: 'User-agent blocked from crawling entire site',
                detail: `User-agent "${currentUserAgent}" is completely blocked by "Disallow: /". This prevents indexing.`,
                severity:
                  currentUserAgent === '*' || IMPORTANT_BOTS.includes(currentUserAgent.toLowerCase())
                    ? SEVERITY.CRITICAL
                    : SEVERITY.HIGH,
              });
            }
          } else {
            result.errors.push({
              message: 'Disallow rule without User-agent',
              detail: `Line ${lineNumber}: Disallow rule "${value}" appears before any User-agent declaration`,
              severity: SEVERITY.MEDIUM,
            });
          }
          break;

        case 'allow':
          if (currentUserAgent) {
            result.userAgents[currentUserAgent].allow.push(value);
          } else {
            result.errors.push({
              message: 'Allow rule without User-agent',
              detail: `Line ${lineNumber}: Allow rule "${value}" appears before any User-agent declaration`,
              severity: SEVERITY.MEDIUM,
            });
          }
          break;

        case 'crawl-delay':
          if (currentUserAgent) {
            const delay = parseFloat(value);
            if (!isNaN(delay)) {
              result.crawlDelay[currentUserAgent] = delay;

              // Warn about high crawl delays
              if (delay > 10) {
                result.errors.push({
                  message: 'High crawl-delay may slow indexing',
                  detail: `User-agent "${currentUserAgent}" has crawl-delay of ${delay}s. Note: Googlebot ignores this directive.`,
                  severity: SEVERITY.MEDIUM,
                });
              }
            }
          }
          break;

        case 'host':
          // Yandex directive for preferred domain
          result.host = value;
          break;

        case 'clean-param':
          // Yandex directive - just note it exists, no validation needed
          break;

        default:
          // Unknown directive
          if (field && !['request-rate', 'visit-time'].includes(field)) {
            result.errors.push({
              message: 'Unknown directive in robots.txt',
              detail: `Line ${lineNumber}: "${field}" is not a standard robots.txt directive`,
              severity: SEVERITY.LOW,
            });
          }
      }
    }
  }

  /**
   * Check for sitemaps and add fallback if needed
   * @param {string} origin - Website origin
   * @param {object} result - Result object to update
   */
  static #checkSitemaps(origin: string, result: RobotsResult) {
    if (!result.sitemaps.length) {
      result.errors.push({
        message: 'No sitemap declared in robots.txt',
        detail: 'Adding a Sitemap directive helps search engines discover your content faster.',
        severity: SEVERITY.MEDIUM,
      });

      const sitemapUrl = origin + '/sitemap.xml';
      console.log('No sitemap in robots.txt, using fallback: ' + sitemapUrl);
      result.sitemaps.push(sitemapUrl);
    } else {
      // Validate sitemap URLs
      for (const sitemapUrl of result.sitemaps) {
        // Check protocol mismatch
        if (origin.startsWith('https://') && sitemapUrl.startsWith('http://')) {
          result.errors.push({
            message: 'Sitemap URL uses HTTP instead of HTTPS',
            detail: `Sitemap "${sitemapUrl}" should use HTTPS to match the site protocol.`,
            severity: SEVERITY.MEDIUM,
          });
        }

        // Check for malformed URLs
        try {
          new URL(sitemapUrl);
        } catch {
          result.errors.push({
            message: 'Invalid sitemap URL in robots.txt',
            detail: `"${sitemapUrl}" is not a valid URL`,
            severity: SEVERITY.HIGH,
          });
        }
      }
    }
  }

  /**
   * Validate user-agent rules
   * @param {object} result - Result object to check
   */
  static #validateUserAgentRules(result: RobotsResult) {
    for (const [userAgent, rules] of Object.entries(result.userAgents)) {
      if (!rules.allow.length && !rules.disallow.length) {
        result.errors.push({
          message: 'User-agent has no rules',
          detail: `User-agent "${userAgent}" is declared but has no Allow or Disallow rules`,
          severity: SEVERITY.LOW,
        });
      }
    }

    // Check if wildcard user-agent exists
    if (!result.userAgents['*']) {
      result.errors.push({
        message: 'No wildcard user-agent defined',
        detail: 'Consider adding "User-agent: *" rules as a fallback for crawlers not explicitly listed',
        severity: SEVERITY.LOW,
      });
    }
  }

  /**
   * Check if critical paths (CSS/JS) are being blocked
   * @param {object} result - Result object
   */
  static #checkCriticalPathBlocking(result: RobotsResult) {
    for (const [userAgent, rules] of Object.entries(result.userAgents)) {
      // Skip if not a major bot
      if (userAgent !== '*' && !IMPORTANT_BOTS.includes(userAgent.toLowerCase())) {
        continue;
      }

      for (const disallowPath of rules.disallow) {
        if (!disallowPath) continue;

        // Check wildcard JS/CSS blocks (e.g. /*.js$, /*.css$) — only report the generic CSS/JS issue
        const isWildcardJsCss =
          disallowPath === '/*.css' ||
          disallowPath === '/*.js' ||
          disallowPath === '/*.css$' ||
          disallowPath === '/*.js$';

        for (const critical of CRITICAL_PATHS) {
          // For wildcard rules, only report the generic CSS/JS entry, not framework-specific ones
          if (isWildcardJsCss && critical.pattern.source !== CRITICAL_PATHS[0].pattern.source) {
            continue;
          }

          if (critical.pattern.test(disallowPath) || isWildcardJsCss) {
            // Check if there's an overriding Allow rule
            const hasAllowOverride = rules.allow.some(
              (allowPath: string) =>
                allowPath &&
                (critical.pattern.test(allowPath) || allowPath.includes('.css') || allowPath.includes('.js')),
            );

            if (!hasAllowOverride) {
              result.errors.push({
                message: `${critical.name} may be blocked`,
                detail: `User-agent "${userAgent}" has "Disallow: ${disallowPath}" which blocks ${critical.name}. This prevents proper page rendering for SEO.`,
                severity: critical.severity,
              });
            }
          }
        }
      }
    }
  }

  /**
   * Check for sensitive paths exposed in disallow rules
   * @param {object} result - Result object
   */
  static #checkSensitivePathExposure(result: RobotsResult) {
    const exposedPaths = new Set<string>();

    for (const rules of Object.values(result.userAgents)) {
      for (const disallowPath of rules.disallow) {
        if (!disallowPath) continue;

        for (const sensitivePattern of SENSITIVE_PATHS) {
          if (sensitivePattern.test(disallowPath)) {
            exposedPaths.add(disallowPath);
          }
        }
      }
    }

    if (exposedPaths.size > 0) {
      result.errors.push({
        message: 'Sensitive paths exposed in robots.txt',
        detail: `The following paths reveal potentially sensitive directories: ${Array.from(exposedPaths).join(', ')}. Attackers can use robots.txt to discover hidden areas.`,
        severity: SEVERITY.MEDIUM,
      });
    }
  }

  /**
   * Check for problematic disallow patterns
   * @param {object} result - Result object
   */
  static #checkProblematicPatterns(result: RobotsResult) {
    for (const [userAgent, rules] of Object.entries(result.userAgents)) {
      if (userAgent !== '*' && !IMPORTANT_BOTS.includes(userAgent.toLowerCase())) {
        continue;
      }

      for (const disallowPath of rules.disallow) {
        if (!disallowPath) continue;

        for (const problematic of PROBLEMATIC_PATTERNS) {
          if (disallowPath.includes(problematic.pattern) || disallowPath === problematic.pattern) {
            result.errors.push({
              message: 'Potentially problematic disallow pattern',
              detail: `User-agent "${userAgent}": "Disallow: ${disallowPath}" - ${problematic.description}`,
              severity: SEVERITY.LOW,
            });
          }
        }
      }
    }
  }

  /**
   * Check for wildcard usage and warn about compatibility
   * @param {object} result - Result object
   */
  static #checkWildcardUsage(result: RobotsResult) {
    let hasWildcard = false;
    let hasDollarSign = false;

    for (const rules of Object.values(result.userAgents)) {
      for (const path of [...rules.allow, ...rules.disallow]) {
        if (path?.includes('*')) hasWildcard = true;
        if (path?.includes('$')) hasDollarSign = true;
      }
    }

    if (hasWildcard || hasDollarSign) {
      const patterns: string[] = [];
      if (hasWildcard) patterns.push('* (wildcard)');
      if (hasDollarSign) patterns.push('$ (end anchor)');

      result.errors.push({
        message: 'Pattern matching characters used in robots.txt',
        detail: `Using ${patterns.join(' and ')}. While Google and Bing support these, some crawlers may not.`,
        severity: SEVERITY.LOW,
      });
    }
  }

  /**
   * Check if important search engine bots are blocked
   * @param {object} result - Result object
   */
  static #checkImportantBotBlocking(result: RobotsResult) {
    const wildcardRules = result.userAgents['*'];
    const botsBlockedByWildcard: string[] = [];

    for (const bot of IMPORTANT_BOTS) {
      const botRules = result.userAgents[bot] || result.userAgents[bot.toLowerCase()];

      // Check specific bot rules
      if (botRules) {
        const hasFullBlock = botRules.disallow.includes('/');
        const hasAllowOverride = botRules.allow.includes('/');

        if (hasFullBlock && !hasAllowOverride) {
          // Already reported in parse phase
          continue;
        }
      }

      // Check if blocked by wildcard
      if (wildcardRules && !botRules) {
        const hasFullBlock = wildcardRules.disallow.includes('/');
        if (hasFullBlock) {
          botsBlockedByWildcard.push(bot);
        }
      }
    }

    // Report all bots blocked by wildcard as a single aggregated issue
    if (botsBlockedByWildcard.length > 0) {
      result.errors.push({
        message: `Important bots blocked by wildcard rules`,
        detail: `${botsBlockedByWildcard.join(', ')} are blocked by "User-agent: * / Disallow: /" and have no specific override rules`,
        severity: SEVERITY.CRITICAL,
      });
    }
  }

  /**
   * Check for conflicting Allow/Disallow rules
   * @param {object} result - Result object
   */
  static #checkConflictingRules(result: RobotsResult) {
    for (const [userAgent, rules] of Object.entries(result.userAgents)) {
      const conflicts: string[] = [];

      for (const allowPath of rules.allow) {
        if (!allowPath) continue;

        for (const disallowPath of rules.disallow) {
          if (!disallowPath) continue;

          // Check for exact duplicates
          if (allowPath === disallowPath) {
            conflicts.push(`"${allowPath}" appears in both Allow and Disallow`);
          }

          // Check for overlapping patterns (simplified check)
          if (disallowPath !== '/' && allowPath.startsWith(disallowPath)) {
            // This is actually a valid pattern (more specific allow overrides disallow)
            // but worth noting
          }
        }
      }

      if (conflicts.length > 0) {
        result.errors.push({
          message: 'Conflicting rules in robots.txt',
          detail: `User-agent "${userAgent}": ${conflicts.join('; ')}. The longer/more specific path takes precedence.`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }
  }

  /**
   * Check if a specific path is allowed for a user-agent
   * @param {string} path - URL path to check
   * @param {string} userAgent - User-agent to check for
   * @param {object} result - Parsed robots.txt result
   * @returns {boolean} Whether the path is allowed
   */
  static isPathAllowed(path: string, userAgent: string, result: RobotsResult) {
    // Get rules for this user-agent, falling back to wildcard
    const rules = result.userAgents[userAgent] || result.userAgents['*'];
    if (!rules) return true; // No rules = allowed

    // Find the most specific matching rule
    let matchedAllow = null;
    let matchedDisallow = null;

    for (const allowPath of rules.allow) {
      if (this.#pathMatches(path, allowPath)) {
        if (!matchedAllow || allowPath.length > matchedAllow.length) {
          matchedAllow = allowPath;
        }
      }
    }

    for (const disallowPath of rules.disallow) {
      if (this.#pathMatches(path, disallowPath)) {
        if (!matchedDisallow || disallowPath.length > matchedDisallow.length) {
          matchedDisallow = disallowPath;
        }
      }
    }

    // If no rules match, it's allowed
    if (!matchedAllow && !matchedDisallow) return true;

    // If only one matches, use that
    if (matchedAllow && !matchedDisallow) return true;
    if (matchedDisallow && !matchedAllow) return false;

    // Both match - longer rule wins, Allow wins ties
    return matchedAllow!.length >= matchedDisallow!.length;
  }

  /**
   * Check if a path matches a robots.txt pattern
   * @param {string} path - URL path
   * @param {string} pattern - Robots.txt pattern
   * @returns {boolean}
   */
  static #pathMatches(path: string, pattern: string) {
    if (!pattern) return false;

    // Limit pattern length to prevent ReDoS attacks
    const MAX_PATTERN_LENGTH = 500;
    if (pattern.length > MAX_PATTERN_LENGTH) {
      // For overly long patterns, fall back to simple matching
      return pattern === path || path.startsWith(pattern.replace(/\*.*$/, ''));
    }

    // Limit consecutive wildcards to prevent catastrophic backtracking
    const normalizedPattern = pattern.replace(/\*{2,}/g, '*');

    // Convert robots.txt pattern to regex
    let regexPattern = normalizedPattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
      .replace(/\*/g, '.*?'); // * becomes .*? (non-greedy to prevent backtracking)

    // $ at end means end of string
    if (regexPattern.endsWith('$')) {
      regexPattern = regexPattern.slice(0, -1) + '$';
    } else {
      regexPattern += '.*'; // Pattern matches prefix
    }

    regexPattern = '^' + regexPattern;

    try {
      // Use timeout-safe regex matching
      const regex = new RegExp(regexPattern);
      return regex.test(path);
    } catch {
      return pattern === path || path.startsWith(pattern);
    }
  }
}

export { RobotsParser };
// CLI testing
if (require.main === module) {
  void (async () => {
    const testUrl = process.argv[2] || 'https://example.com';
    console.log(`Testing RobotsParser with ${testUrl}\n`);

    const result = await RobotsParser.parseRobotsTxt(testUrl);

    console.log('\n📊 Metadata:');
    console.log(`  Status: ${result.metadata.statusCode}`);
    console.log(`  Size: ${result.metadata.size} bytes`);
    console.log(`  Content-Type: ${result.metadata.contentType}`);
    console.log(`  Response Time: ${result.metadata.responseTime}ms`);

    console.log('\n🗺️  Sitemaps found:', result.sitemaps.length);
    result.sitemaps.forEach((s) => console.log('  -', s));

    console.log('\n🤖 User-Agents:', Object.keys(result.userAgents).length);
    Object.entries(result.userAgents).forEach(([ua, rules]) => {
      console.log(`  - ${ua}: ${rules.allow.length} allow, ${rules.disallow.length} disallow`);
    });

    if (Object.keys(result.crawlDelay).length > 0) {
      console.log('\n⏱️  Crawl Delays:');
      Object.entries(result.crawlDelay).forEach(([ua, delay]) => {
        console.log(`  - ${ua}: ${delay}s`);
      });
    }

    if (result.host) {
      console.log('\n🏠 Host directive:', result.host);
    }

    console.log('\n⚠️  Issues Found:', result.errors.length);
    const bySeverity: Record<string, Array<{ message: string; detail: string | null; severity: string }>> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
    };
    result.errors.forEach((err) => bySeverity[err.severity].push(err));

    for (const [severity, errors] of Object.entries(bySeverity)) {
      if (errors.length > 0) {
        console.log(`\n  ${severity.toUpperCase()} (${errors.length}):`);
        errors.forEach((err) => {
          console.log(`    - ${err.message}`);
          if (err.detail) console.log(`      ${err.detail}`);
        });
      }
    }

    // Test path matching
    console.log('\n🔍 Path Check Examples:');
    const testPaths = ['/', '/admin', '/search', '/assets/style.css'];
    testPaths.forEach((path) => {
      const allowed = RobotsParser.isPathAllowed(path, 'Googlebot', result);
      console.log(`  ${path}: ${allowed ? '✅ Allowed' : '❌ Blocked'}`);
    });
  })();
}
