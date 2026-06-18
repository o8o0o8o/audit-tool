/**
 * Source Mapper
 * Maps audit issues from crawl results to source file locations in the repository
 */

import * as fs from 'fs';
import * as path from 'path';

interface FrameworkInfo {
  framework: string | null;
  version: string | null;
  packageJson: Record<string, unknown>;
  srcDirs: string[];
  configFile: string | null;
  router: string | null;
}

interface SourceLocation {
  file: string;
  line: number;
  context: string;
  suggestion: string;
}

interface FindCriteria {
  positive: RegExp | null;
  negative: RegExp | null;
  suggestion: string;
  context: string;
  countPattern?: RegExp;
  minCount?: number;
  /**
   * Skip include/partial/embed files. These fragments (a slider partial, an
   * iframe-embed document) have no document `<head>` of their own — or a
   * throwaway one — so citing them for a missing page-level `<title>`,
   * description, canonical or Open Graph tag is wrong and misleading. Set on the
   * head-level mappers; left off for h1/alt mappers, where a partial IS the
   * right place to fix the markup.
   */
  skipFragments?: boolean;
}

/**
 * Is this an include/partial/embed fragment rather than a full page/document?
 * Recognises the underscore-prefixed-partial convention (11ty/Jekyll/Sass) and
 * common fragment directory names.
 */
function isFragmentPath(relPath: string): boolean {
  const segs = relPath.split(/[\\/]/);
  const base = segs[segs.length - 1];
  if (base.startsWith('_')) return true;
  return segs.some((s) => /^(_?includes?|partials?|components?|fragments?|embeds?|embed|snippets?)$/i.test(s));
}

interface LineSearchCriteria {
  linePattern: RegExp;
  suggestion: string;
  context: string;
}

class SourceMapper {
  /**
   * Map audit issues to source file locations
   * @param {object} analysisDetails - analysis.details from ErrorAggregator (keyed by message)
   * @param {string} repoPath - Absolute path to the repository
   * @param {object} frameworkInfo - Output from RepoFrameworkDetector.detect()
   * @returns {Object<string, Array<{ file: string, line: number, context: string, suggestion: string }>>}
   *   Keyed by issue message, each value is an array of source locations
   */
  static map(
    analysisDetails: Record<string, unknown>,
    repoPath: string,
    frameworkInfo: FrameworkInfo,
  ): Record<string, SourceLocation[]> {
    if (!analysisDetails || !repoPath || !frameworkInfo) return {};

    const mapping: Record<string, SourceLocation[]> = {};
    const { framework, srcDirs } = frameworkInfo;

    // Build a set of issue keys present in the analysis
    const issueKeys = new Set(Object.keys(analysisDetails));

    // Map each known issue type to source locations
    for (const [issueKey, mapper] of Object.entries(this.#ISSUE_MAPPERS)) {
      // Match issue keys that start with the pattern (some keys are dynamic like "Some pages have...")
      const matchedKey = this.#findMatchingKey(issueKeys, issueKey);
      if (!matchedKey) continue;

      try {
        const locations = mapper.call(this, repoPath, framework ?? '', srcDirs);
        if (locations.length > 0) {
          // Merge rather than overwrite: a single analysis key can contain two
          // distinct mapper substrings (e.g. "titles too short and images
          // without alt"), and each mapper's locations must be kept.
          mapping[matchedKey] = (mapping[matchedKey] ?? []).concat(locations);
        }
      } catch {
        // Skip if mapper fails
      }
    }

    return mapping;
  }

  /**
   * Issue pattern -> mapper function
   * Keys are substrings matched against analysis.details keys
   */
  static #ISSUE_MAPPERS = {
    // Only structural, source-visible facts are mapped. A title/description that
    // is "too short"/"too long" is a CONTENT-LENGTH fact, not a structural one:
    // the value is typically composed at runtime (generateMetadata, a CMS field,
    // a title template) and is not knowable from a static scan. The old length
    // entries fell through to #mapMissingTitle, which cited "page without
    // metadata export" — wrong for a title that exists, and identical for the
    // mutually-exclusive "too short" and "too long" findings. So length findings
    // are deliberately NOT mapped; only genuinely-missing tags are.
    'Title is missing': SourceMapper.#mapMissingTitle,
    'Description meta tag is missing': SourceMapper.#mapMissingDescription,
    'Canonicals are not set': SourceMapper.#mapMissingCanonical,
    'more than one h1 tag': SourceMapper.#mapH1Issues,
    // Substrings must be CONTAINED in the analyzer's emitted message. The schema
    // and Open Graph analyzers emit "Low structured data coverage" / "Low Open
    // Graph tag coverage" (not "Missing …"), so match on the shared phrase.
    'structured data': SourceMapper.#mapMissingStructuredData,
    'Open Graph': SourceMapper.#mapMissingOpenGraph,
    'images without alt': SourceMapper.#mapMissingAltText,
    'alt text is missing': SourceMapper.#mapMissingAltText,
  };

  /**
   * Find the first key in the set that contains the given substring
   */
  static #findMatchingKey(keySet: Set<string>, substring: string) {
    for (const key of keySet) {
      if (key.includes(substring)) return key;
    }
    return null;
  }

  // --- Issue mapper methods ---

  static #mapMissingTitle(repoPath: string, framework: string, srcDirs: string[]) {
    const locations = [];

    switch (framework) {
      case 'Next.js':
        // Check layout files for metadata export with title
        locations.push(
          ...this.#findInFiles(repoPath, srcDirs, /^layout\.(tsx|jsx|js|ts)$/, {
            positive: /export\s+(const|let|var)\s+metadata\b|export\s+(async\s+)?function\s+generateMetadata\b/,
            negative: /title\s*[=:]/, // should have title in metadata
            suggestion: 'Add a title field to the metadata export or generateMetadata function',
            context: 'metadata export',
          }),
        );
        // Check page files that might need their own title
        locations.push(
          ...this.#findInFiles(repoPath, srcDirs, /^page\.(tsx|jsx|js|ts)$/, {
            positive: null, // all page files
            negative: /export\s+(const|let|var)\s+metadata\b|export\s+(async\s+)?function\s+generateMetadata\b/,
            suggestion: 'Export metadata or generateMetadata with a title for this page',
            context: 'page without metadata export',
          }),
        );
        break;

      case 'Nuxt':
        locations.push(
          ...this.#findInFiles(repoPath, ['pages'], /\.(vue)$/, {
            positive: null,
            negative: /useHead\s*\(|useSeoMeta\s*\(|<Title>|definePageMeta/,
            suggestion: 'Add useHead({ title: "..." }) or useSeoMeta({ title: "..." }) to this page',
            context: 'page without head management',
          }),
        );
        break;

      case 'Gatsby':
        locations.push(
          ...this.#findInFiles(repoPath, ['src/pages', 'src/templates'], /\.(tsx|jsx|js)$/, {
            positive: null,
            negative: /export\s+(const|function)\s+Head\b|Helmet|useStaticQuery/,
            suggestion: 'Add a Head export with a <title> tag or use react-helmet',
            context: 'page without Head export',
          }),
        );
        break;

      case 'Astro':
        locations.push(
          ...this.#findInFiles(repoPath, ['src/pages'], /\.astro$/, {
            positive: null,
            negative: /<title>|<title\s/,
            suggestion: 'Add a <title> tag in the frontmatter or layout head',
            context: 'page without title tag',
          }),
        );
        break;

      default:
        locations.push(
          ...this.#findInFiles(repoPath, srcDirs, /\.(html|htm)$/, {
            // Require a real document <head> so include/partial fragments (which
            // have none) aren't flagged for a "missing" title they never own.
            positive: /<head[\s>]/i,
            negative: /<title>/i,
            suggestion: 'Add a <title> tag in the <head> section',
            context: 'HTML document without title',
            skipFragments: true,
          }),
        );
    }

    return locations;
  }

  static #mapMissingDescription(repoPath: string, framework: string, srcDirs: string[]) {
    const locations = [];

    switch (framework) {
      case 'Next.js':
        locations.push(
          ...this.#findInFiles(repoPath, srcDirs, /^layout\.(tsx|jsx|js|ts)$/, {
            positive: /export\s+(const|let|var)\s+metadata\b|export\s+(async\s+)?function\s+generateMetadata\b/,
            negative: /description\s*[=:]/,
            suggestion: 'Add a description field to the metadata export',
            context: 'metadata export without description',
          }),
        );
        break;

      case 'Nuxt':
        locations.push(
          ...this.#findInFiles(repoPath, ['pages'], /\.(vue)$/, {
            positive: /useHead\s*\(|useSeoMeta\s*\(/,
            negative: /description/,
            suggestion: 'Add description to useHead() or useSeoMeta() call',
            context: 'head composable without description',
          }),
        );
        break;

      case 'Astro':
        locations.push(
          ...this.#findInFiles(repoPath, ['src/layouts'], /\.astro$/, {
            positive: /<head[\s>]/,
            negative: /meta\s+name=["']description["']/i,
            suggestion: 'Add <meta name="description" content="..."> to the layout head',
            context: 'layout head without meta description',
          }),
        );
        break;

      default:
        locations.push(
          ...this.#findInFiles(repoPath, srcDirs, /\.(html|htm)$/, {
            // Require a real document <head> so include/partial fragments aren't
            // flagged for a "missing" meta description they never own.
            positive: /<head[\s>]/i,
            negative: /meta\s+name=["']description["']/i,
            suggestion: 'Add <meta name="description" content="..."> to the <head>',
            context: 'HTML document without meta description',
            skipFragments: true,
          }),
        );
    }

    return locations;
  }

  static #mapMissingCanonical(repoPath: string, framework: string, srcDirs: string[]) {
    const locations = [];

    switch (framework) {
      case 'Next.js':
        // In App Router, canonical is set via metadata.alternates.canonical
        locations.push(
          ...this.#findInFiles(repoPath, srcDirs, /^layout\.(tsx|jsx|js|ts)$/, {
            positive: /export\s+(const|let|var)\s+metadata\b|export\s+(async\s+)?function\s+generateMetadata\b/,
            negative: /canonical|alternates/,
            suggestion: 'Add alternates.canonical to the metadata export',
            context: 'metadata export without canonical',
          }),
        );
        break;

      case 'Nuxt':
        locations.push(
          ...this.#findInFiles(repoPath, ['pages'], /\.(vue)$/, {
            positive: /useHead\s*\(/,
            negative: /canonical/,
            suggestion: 'Add a canonical link to useHead({ link: [{ rel: "canonical", href: "..." }] })',
            context: 'useHead without canonical',
          }),
        );
        break;

      default:
        locations.push(
          ...this.#findInFiles(repoPath, srcDirs, /\.(html|htm|astro)$/, {
            positive: /<head[\s>]/,
            negative: /rel=["']canonical["']/i,
            suggestion: 'Add <link rel="canonical" href="..."> to the head',
            context: 'document without canonical link',
            // Skip iframe-embed standalone docs (e.g. src/embed/*.html): they
            // have a <head> but aren't crawlable pages, so a "missing canonical"
            // page finding shouldn't point at them.
            skipFragments: true,
          }),
        );
    }

    return locations;
  }

  static #mapH1Issues(repoPath: string, framework: string, srcDirs: string[]) {
    const locations = [];
    const componentPattern = framework === 'Nuxt' ? /\.vue$/ : /\.(tsx|jsx|js|ts|astro)$/;
    const searchDirs =
      framework === 'Nuxt'
        ? ['pages', 'components']
        : framework === 'Astro'
          ? ['src/pages', 'src/components']
          : srcDirs;

    // Find files with multiple h1 tags
    locations.push(
      ...this.#findInFiles(repoPath, searchDirs, componentPattern, {
        positive: /<h1[\s>]/i,
        negative: null, // We want files WITH h1 tags
        suggestion: 'Ensure only one <h1> tag per page. Use <h2>-<h6> for sub-sections',
        context: 'file containing h1 tag(s)',
        countPattern: /<h1[\s>]/gi,
        minCount: 2, // Only flag if multiple h1s in one file
      }),
    );

    return locations;
  }

  static #mapMissingStructuredData(repoPath: string, framework: string, srcDirs: string[]) {
    const locations = [];

    // Search for existing structured data to show where it's implemented (or missing)
    const layoutPattern =
      framework === 'Next.js'
        ? /^layout\.(tsx|jsx|js|ts)$/
        : framework === 'Astro'
          ? /\.astro$/
          : framework === 'Nuxt'
            ? /\.vue$/
            : /\.(html|htm)$/;
    const layoutDirs = framework === 'Astro' ? ['src/layouts'] : framework === 'Nuxt' ? ['layouts'] : srcDirs;

    locations.push(
      ...this.#findInFiles(repoPath, layoutDirs, layoutPattern, {
        positive: null,
        negative: /application\/ld\+json|useSchemaOrg|JsonLd/,
        suggestion: 'Add structured data (JSON-LD) to improve search result appearance',
        context: 'layout without structured data',
      }),
    );

    return locations;
  }

  static #mapMissingOpenGraph(repoPath: string, framework: string, srcDirs: string[]) {
    const locations = [];

    switch (framework) {
      case 'Next.js':
        locations.push(
          ...this.#findInFiles(repoPath, srcDirs, /^layout\.(tsx|jsx|js|ts)$/, {
            positive: /export\s+(const|let|var)\s+metadata\b|export\s+(async\s+)?function\s+generateMetadata\b/,
            negative: /openGraph|og:/,
            suggestion: 'Add openGraph to the metadata export for social sharing',
            context: 'metadata export without Open Graph',
          }),
        );
        break;

      case 'Nuxt':
        locations.push(
          ...this.#findInFiles(repoPath, ['pages'], /\.vue$/, {
            positive: /useHead\s*\(|useSeoMeta\s*\(/,
            negative: /ogTitle|og:title|ogDescription/,
            suggestion: 'Add ogTitle and ogDescription to useSeoMeta()',
            context: 'head composable without OG tags',
          }),
        );
        break;

      default:
        locations.push(
          ...this.#findInFiles(repoPath, srcDirs, /\.(html|htm|astro)$/, {
            positive: /<head[\s>]/,
            negative: /og:title|property=["']og:/i,
            suggestion: 'Add Open Graph meta tags for social sharing',
            context: 'document without OG tags',
            skipFragments: true,
          }),
        );
    }

    return locations;
  }

  static #mapMissingAltText(repoPath: string, framework: string, srcDirs: string[]) {
    const locations = [];
    const componentPattern = framework === 'Nuxt' ? /\.vue$/ : /\.(tsx|jsx|js|ts|astro)$/;

    // Find files with images missing alt text
    locations.push(
      ...this.#findInFilesWithLineSearch(repoPath, srcDirs, componentPattern, {
        // `(?<![-\w])alt` so a hyphenated attribute like `data-alt` does not
        // satisfy the "has alt" lookahead and mask a genuinely missing alt.
        linePattern: /<img\s(?![^>]*(?<![-\w])alt\s*=)[^>]*>|<Image\s(?![^>]*(?<![-\w])alt\s*=)[^>]*>/,
        suggestion: 'Add descriptive alt text to all <img> and <Image> elements',
        context: 'image without alt attribute',
      }),
    );

    return locations;
  }

  // --- Helpers ---

  /**
   * Find files matching criteria and return source locations
   * @param {string} repoPath
   * @param {string[]} dirs - Directories to search
   * @param {RegExp} filePattern - Filename pattern
   * @param {object} criteria
   * @param {RegExp|null} criteria.positive - Content must match this (null = all files)
   * @param {RegExp|null} criteria.negative - Content must NOT match this (null = no negative check)
   * @param {string} criteria.suggestion
   * @param {string} criteria.context
   * @param {RegExp} [criteria.countPattern] - Pattern to count occurrences
   * @param {number} [criteria.minCount] - Minimum count to flag
   * @returns {Array<{ file: string, line: number, context: string, suggestion: string }>}
   */
  static #findInFiles(repoPath: string, dirs: string[], filePattern: RegExp, criteria: FindCriteria): SourceLocation[] {
    const results: SourceLocation[] = [];
    const seen = new Set();
    const maxResults = 20;

    for (const dir of dirs) {
      if (results.length >= maxResults) break;
      const absDir = path.join(repoPath, dir);
      if (!fs.existsSync(absDir)) continue;

      this.#walkDir(absDir, (filePath) => {
        if (results.length >= maxResults) return;
        const basename = path.basename(filePath);
        if (!filePattern.test(basename)) return;

        const relPath = path.relative(repoPath, filePath);
        if (seen.has(relPath)) return;
        seen.add(relPath);

        // Head-level findings must not cite include/partial/embed fragments.
        if (criteria.skipFragments && isFragmentPath(relPath)) return;

        let content;
        try {
          content = fs.readFileSync(filePath, 'utf-8');
        } catch {
          return;
        }

        // If positive pattern specified, file must match it
        if (criteria.positive && !criteria.positive.test(content)) return;

        // Count pattern check (e.g., multiple h1s)
        if (criteria.countPattern) {
          const matches = content.match(criteria.countPattern);
          if (!matches || matches.length < (criteria.minCount ?? 1)) return;

          // Find line number of first occurrence
          const line = this.#findLineNumber(content, criteria.countPattern);
          results.push({
            file: relPath,
            line,
            context: criteria.context,
            suggestion: criteria.suggestion,
          });
          return;
        }

        // If negative pattern specified, file must NOT match it
        if (criteria.negative?.test(content)) return;

        // File matches criteria - find relevant line number
        const line = criteria.positive ? this.#findLineNumber(content, criteria.positive) : 1;

        results.push({
          file: relPath,
          line,
          context: criteria.context,
          suggestion: criteria.suggestion,
        });
      });
    }

    return results;
  }

  /**
   * Find files with specific line-level pattern matches (e.g., img without alt)
   */
  static #findInFilesWithLineSearch(
    repoPath: string,
    dirs: string[],
    filePattern: RegExp,
    criteria: LineSearchCriteria,
  ): SourceLocation[] {
    const results: SourceLocation[] = [];
    const seen = new Set();
    const maxResults = 20;

    for (const dir of dirs) {
      if (results.length >= maxResults) break;
      const absDir = path.join(repoPath, dir);
      if (!fs.existsSync(absDir)) continue;

      this.#walkDir(absDir, (filePath) => {
        if (results.length >= maxResults) return;
        const basename = path.basename(filePath);
        if (!filePattern.test(basename)) return;

        const relPath = path.relative(repoPath, filePath);
        if (seen.has(relPath)) return;
        seen.add(relPath);

        let content;
        try {
          content = fs.readFileSync(filePath, 'utf-8');
        } catch {
          return;
        }

        // Search line-by-line for the pattern
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break;
          if (criteria.linePattern.test(lines[i])) {
            results.push({
              file: relPath,
              line: i + 1,
              context: criteria.context,
              suggestion: criteria.suggestion,
            });
            break; // One result per file
          }
        }
      });
    }

    return results;
  }

  /**
   * Find the line number of the first match of a pattern in content
   */
  static #findLineNumber(content: string, pattern: RegExp) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Reset lastIndex for global regexes to avoid stateful .test() behavior
      if (pattern.lastIndex !== undefined) pattern.lastIndex = 0;
      if (pattern.test(lines[i])) return i + 1;
    }
    return 1;
  }

  /**
   * Recursively walk a directory, calling callback for each file
   */
  static #walkDir(dir: string, callback: (filePath: string) => void, maxDepth = 8, depth = 0) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'build' ||
        entry.name === 'out' ||
        entry.name === 'coverage' ||
        entry.name === '__tests__' ||
        entry.name === '__mocks__'
      )
        continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.#walkDir(fullPath, callback, maxDepth, depth + 1);
      } else {
        callback(fullPath);
      }
    }
  }
}

export { SourceMapper };
