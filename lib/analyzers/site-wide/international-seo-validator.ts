import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

/**
 * Site-wide International SEO Validator
 * Checks international SEO and hreflang consistency across all pages.
 */
class InternationalSEOValidator {
  /**
   * Validate international SEO consistency across all pages.
   *
   * @param {Object} allPages - Object containing all page data { url: pageData }
   * @param {boolean} isMultiLang - Whether the site is multilanguage
   * @returns {Object} { issues: [], warnings: [], stats: {} }
   */
  static validateInternationalSEOConsistency(allPages: Record<string, PageInfo>, isMultiLang: boolean) {
    if (!isMultiLang) {
      console.log('\nSite is not multilanguage, skipping international SEO analysis');
      return { issues: [], warnings: [], stats: {} };
    }

    console.log('\nChecking international SEO consistency across pages...');

    const stats = {
      languages: new Map<string, { count: number; pages: string[] }>(),
      urlStructures: new Map<string, number>(),
      missingLangAttribute: [] as string[],
      inconsistentCharset: [] as { url: string; charset: string }[],
      missingXDefault: 0,
      missingSelfReferential: [] as string[],
      noLanguageSwitcher: [] as string[],
      contentLengthByLang: new Map<string, number>(),
      pagesWithHreflang: 0,
      pagesWithoutHreflang: 0,
    };

    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    // Analyze each page
    for (const url in allPages) {
      const page = allPages[url];

      if (!page.internationalSEO) continue;

      const intl = page.internationalSEO;

      // Track languages
      if (intl.language) {
        if (!stats.languages.has(intl.language)) {
          stats.languages.set(intl.language, { count: 0, pages: [] });
        }
        const langStats = stats.languages.get(intl.language)!;
        langStats!.count++;
        langStats!.pages.push(url);

        // Track content length per language
        const contentLength = page.contentQuality?.textLength || 0;
        const currentLength = stats.contentLengthByLang.get(intl.language) || 0;
        stats.contentLengthByLang.set(intl.language, currentLength + contentLength);
      }

      // Track URL structures
      if (intl.urlStructure) {
        const currentCount = stats.urlStructures.get(intl.urlStructure) || 0;
        stats.urlStructures.set(intl.urlStructure, currentCount + 1);
      }

      // Track missing lang attribute
      if (!intl.hasLangAttribute) {
        stats.missingLangAttribute.push(url);
      }

      // Track charset issues
      if (intl.charset && intl.charset.toLowerCase() !== 'utf-8') {
        stats.inconsistentCharset.push({ url, charset: intl.charset });
      }

      // Track hreflang implementation
      if (intl.hasHreflang) {
        stats.pagesWithHreflang++;

        if (!intl.hasXDefault) {
          stats.missingXDefault++;
        }

        if (!intl.hasSelfReferential) {
          stats.missingSelfReferential.push(url);
        }
      } else if (isMultiLang) {
        stats.pagesWithoutHreflang++;
      }

      // Track language switcher
      if (intl.hasHreflang && intl.warnings.includes('No visible language switcher found (user experience issue)')) {
        stats.noLanguageSwitcher.push(url);
      }
    }

    const totalPages = Object.keys(allPages).length;

    console.log(`Languages found: ${Array.from(stats.languages.keys()).join(', ')}`);
    console.log(`Pages with hreflang: ${stats.pagesWithHreflang}/${totalPages}`);

    // Report 1: Missing lang attribute
    if (stats.missingLangAttribute.length > 0) {
      const urlList = stats.missingLangAttribute.slice(0, 10).map(u => `<li><a href="${u}">${u}</a></li>`).join('');
      const moreCount = stats.missingLangAttribute.length > 10 ? ` (showing 10 of ${stats.missingLangAttribute.length})` : '';

      issues.push({
        title: `Pages missing HTML lang attribute`,
        description: `${stats.missingLangAttribute.length} page(s) are missing the lang attribute on the <html> tag${moreCount}:<ul>${urlList}</ul>`,
        severity: SEVERITY.HIGH
      });
    }

    // Report 2: Mixed URL structures
    if (stats.urlStructures.size > 1) {
      const structureList = Array.from(stats.urlStructures.entries())
        .map(([type, count]) => `<li>${type}: ${count} pages</li>`)
        .join('');

      issues.push({
        title: `Inconsistent international URL structure`,
        description: `Multiple URL structures detected for international content. Stick to one approach (subdirectory, subdomain, or ccTLD):<ul>${structureList}</ul>`,
        severity: SEVERITY.MEDIUM
      });
    }

    // Report 3: Missing x-default
    if (stats.missingXDefault > stats.pagesWithHreflang * 0.5 && stats.pagesWithHreflang > 0) {
      issues.push({
        title: `Many pages missing x-default hreflang`,
        description: `${stats.missingXDefault} page(s) with hreflang are missing the x-default tag. This should point to a default/fallback version for unmatched languages.`,
        severity: SEVERITY.MEDIUM
      });
    }

    // Report 4: Missing self-referential hreflang
    if (stats.missingSelfReferential.length > 10) {
      const urlList = stats.missingSelfReferential.slice(0, 5).map(u => `<li><a href="${u}">${u}</a></li>`).join('');

      issues.push({
        title: `Pages missing self-referential hreflang`,
        description: `${stats.missingSelfReferential.length} page(s) don't include self-referential hreflang tags (each page should reference itself):<ul>${urlList}</ul>`,
        severity: SEVERITY.MEDIUM
      });
    }

    // Report 5: Non-UTF-8 charset
    if (stats.inconsistentCharset.length > 0) {
      const charsetList = stats.inconsistentCharset.slice(0, 5).map(item =>
        `<li><a href="${item.url}">${item.url}</a> (${item.charset})</li>`
      ).join('');

      issues.push({
        title: `Pages using non-UTF-8 charset`,
        description: `${stats.inconsistentCharset.length} page(s) use non-UTF-8 charset. UTF-8 is recommended for international sites:<ul>${charsetList}</ul>`,
        severity: SEVERITY.MEDIUM
      });
    }

    // Report 6: Content parity (check if languages have similar content amounts)
    if (stats.languages.size > 1) {
      const avgLengths = new Map();
      for (const [lang, data] of stats.languages) {
        const totalLength = stats.contentLengthByLang.get(lang) || 0;
        avgLengths.set(lang, Math.round(totalLength / data.count));
      }

      // Find language with most content
      const lengths = Array.from(avgLengths.values());
      const maxLength = Math.max(...lengths);
      const minLength = Math.min(...lengths);

      // If there's a >50% difference, warn about content parity
      if (maxLength > 0 && (minLength / maxLength) < 0.5) {
        const lengthList = Array.from(avgLengths.entries())
          .map(([lang, len]) => `<li>${lang}: ${len} chars average per page</li>`)
          .join('');

        issues.push({
          title: `Significant content length disparity across languages`,
          description: `Some language versions have significantly less content than others. This may indicate incomplete translations or thin content:<ul>${lengthList}</ul>`,
          severity: SEVERITY.MEDIUM
        });
      }
    }

    // Report 7: Pages without hreflang on multilanguage site
    if (stats.pagesWithoutHreflang > 0 && stats.pagesWithHreflang > 0) {
      const percentWithout = Math.round((stats.pagesWithoutHreflang / totalPages) * 100);

      if (percentWithout > 20) {
        issues.push({
          title: `Many pages missing hreflang on multilanguage site`,
          description: `${stats.pagesWithoutHreflang} page(s) (${percentWithout}%) don't have hreflang tags, but the site is multilanguage. Add hreflang to all language versions.`,
          severity: SEVERITY.HIGH
        });
      }
    }

    // Report 8: Missing language switcher
    if (stats.noLanguageSwitcher.length > stats.pagesWithHreflang * 0.3) {
      warnings.push({
        title: `Many pages missing language switcher`,
        description: `${stats.noLanguageSwitcher.length} page(s) have hreflang but no visible language switcher. This impacts user experience.`,
        severity: SEVERITY.LOW
      });
    }

    console.log(`Content parity check: ${stats.languages.size} languages analyzed`);
    console.log(`URL structures: ${Array.from(stats.urlStructures.keys()).join(', ')}`);

    return {
      issues,
      warnings,
      stats: {
        languageCount: stats.languages.size,
        languages: Array.from(stats.languages.entries()).map(([lang, data]) => ({
          language: lang,
          pageCount: data.count,
          avgContentLength: Math.round((stats.contentLengthByLang.get(lang) || 0) / data.count)
        })),
        urlStructures: Array.from(stats.urlStructures.entries()).map(([type, count]) => ({ type, count })),
        hreflangCoverage: totalPages > 0 ? Math.round((stats.pagesWithHreflang / totalPages) * 100) : 0,
        pagesWithHreflang: stats.pagesWithHreflang,
        pagesWithoutHreflang: stats.pagesWithoutHreflang,
      }
    };
  }

  /**
   * Validate hreflang consistency across all pages.
   *
   * @param {Object} allPages - Object containing all page data { url: pageData }
   * @param {boolean} isMultiLang - Whether the site is multilanguage
   * @returns {Object} { issues: [], warnings: [], stats: {} }
   */
  static validateHreflangConsistency(allPages: Record<string, PageInfo>, isMultiLang: boolean) {
    // Only run this check if the site is multilanguage
    if (!isMultiLang) {
      return { issues: [], warnings: [], stats: {} };
    }

    console.log('\nChecking hreflang consistency across pages...');

    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    // Build language groups
    // A language group is a set of pages that should all reference each other
    // We identify groups by collecting all URLs mentioned in alternates + the page itself
    const processedUrls = new Set();
    const languageGroups = [];

    for (const url in allPages) {
      const page = allPages[url];

      // Skip if already processed or no alternates
      if (processedUrls.has(url) || !page.alternates || page.alternates.length === 0) {
        continue;
      }

      // Build a group from this page
      const group = new Map(); // hreflang -> URL

      // Add the current page (determine its language from canonical or self-reference)
      let currentPageLang = null;

      // Try to find the current page's language from its alternates
      for (const alt of page.alternates) {
        if (alt.href === url || alt.href === page.canonical) {
          currentPageLang = alt.hreflang;
          break;
        }
      }

      // If we found the current page's language, add it to the group
      if (currentPageLang && currentPageLang !== 'x-default') {
        group.set(currentPageLang, url);
      }

      // Add all alternates to the group
      for (const alt of page.alternates) {
        if (alt.hreflang && alt.hreflang !== 'x-default') {
          // Check for duplicate hreflang in this page's alternates
          if (group.has(alt.hreflang) && group.get(alt.hreflang) !== alt.href) {
            issues.push({
              title: `Multiple pages linked for the same hreflang on a single page`,
              description: `Page <a href="${url}">${url}</a> links to multiple URLs for hreflang="${alt.hreflang}": <a href="${group.get(alt.hreflang)}">${group.get(alt.hreflang)}</a> and <a href="${alt.href}">${alt.href}</a>`,
              severity: SEVERITY.HIGH
            });
          }
          group.set(alt.hreflang, alt.href);
        }
      }

      // Mark all URLs in this group as processed
      processedUrls.add(url);
      for (const [, groupUrl] of group) {
        processedUrls.add(groupUrl);
      }

      // Store the group for bidirectional check
      if (group.size > 0) {
        languageGroups.push({ rootUrl: url, group });
      }
    }

    console.log(`Found ${languageGroups.length} language groups`);

    // Check 1: Within each language group, check for duplicate hreflang assignments
    // (e.g., two different URLs in the same group both pointing to the same hreflang)
    let duplicateLangCount = 0;

    for (const { rootUrl, group } of languageGroups) {
      // Within this group, check if any hreflang is assigned to multiple different URLs
      const langToUrls = new Map();
      for (const [lang, groupUrl] of group) {
        if (lang === 'x-default') continue;
        if (!langToUrls.has(lang)) langToUrls.set(lang, []);
        langToUrls.get(lang).push(groupUrl);
      }

      for (const [lang, urls] of langToUrls) {
        const uniqueUrls = [...new Set(urls)];
        if (uniqueUrls.length > 1) {
          duplicateLangCount++;
          const urlList = uniqueUrls.map(u => `<li><a href="${u}">${u}</a></li>`).join('');
          issues.push({
            title: `Duplicate hreflang assignment within language group`,
            description: `${uniqueUrls.length} different URLs claim hreflang="${lang}" in the same language group:<ul>${urlList}</ul>`,
            severity: SEVERITY.HIGH
          });
        }
      }
    }

    // Check 2: Incomplete bidirectional hreflang links
    let incompleteLinkCount = 0;

    for (const { rootUrl, group } of languageGroups) {
      const expectedUrls = new Set(group.values());
      const expectedLangs = new Set(group.keys());

      // For each URL in the group, check if it has links to all other URLs
      for (const [lang, groupUrl] of group) {
        const page = allPages[groupUrl];

        if (!page) {
          // Page might not have been crawled
          continue;
        }

        // Build set of URLs this page links to
        const linkedUrls = new Set();
        if (page.alternates) {
          for (const alt of page.alternates) {
            if (alt.hreflang && alt.hreflang !== 'x-default') {
              linkedUrls.add(alt.href);
            }
          }
        }

        // Add self-reference if present
        linkedUrls.add(groupUrl);
        if (page.canonical) {
          linkedUrls.add(page.canonical);
        }

        // Check for missing links
        const missingUrls = [];
        const missingLangs: string[] = [];

        for (const [expectedLang, expectedUrl] of group) {
          if (expectedUrl !== groupUrl && !linkedUrls.has(expectedUrl)) {
            missingUrls.push(expectedUrl);
            missingLangs.push(expectedLang);
          }
        }

        if (missingUrls.length > 0) {
          incompleteLinkCount++;
          const missingList = missingUrls.map((url, i) =>
            `<li><a href="${url}">${url}</a> (${missingLangs[i]})</li>`
          ).join('');

          issues.push({
            title: `Incomplete bidirectional hreflang links`,
            description: `Page <a href="${groupUrl}">${groupUrl}</a> (${lang}) is missing hreflang links to ${missingUrls.length} page(s) in its language group:<ul>${missingList}</ul>`,
            severity: SEVERITY.HIGH
          });
        }
      }
    }

    if (duplicateLangCount > 0) {
      console.log(`Found ${duplicateLangCount} cases of duplicate language claims`);
    }
    if (incompleteLinkCount > 0) {
      console.log(`Found ${incompleteLinkCount} pages with incomplete bidirectional hreflang links`);
    }
    if (duplicateLangCount === 0 && incompleteLinkCount === 0) {
      console.log('Hreflang structure is consistent');
    }

    return {
      issues,
      warnings,
      stats: {
        languageGroups: languageGroups.length,
        duplicateLangCount,
        incompleteLinkCount
      }
    };
  }
}

export { InternationalSEOValidator };