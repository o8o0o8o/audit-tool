import { SEVERITY } from '../../constants';
import { formatUrlList } from '../../utils';
import type { Issue, PageInfo } from '../../types';

/**
 * Site-wide Duplicate Checker
 * Analyzes all pages to detect duplicate titles and meta descriptions.
 */
class DuplicateChecker {
  /**
   * Check for duplicate titles and descriptions across all pages.
   *
   * @param {Object} allPages - Object containing all page data { url: pageData }
   * @returns {Object} { duplicateTitles: Map, duplicateDescriptions: Map, issues: [] }
   */
  static checkDuplicates(allPages: Record<string, PageInfo>) {
    console.log('\nChecking for duplicate titles and descriptions...');

    const titleMap: Record<string, string[]> = {}; // title -> array of URLs
    const descriptionMap: Record<string, string[]> = {}; // description -> array of URLs
    const issues: Issue[] = [];

    // Build maps of titles and descriptions
    for (const url in allPages) {
      const page = allPages[url];

      // Track titles (skip empty ones as they're already reported)
      if (page.title?.trim()) {
        const title = page.title.trim();
        if (!titleMap[title]) {
          titleMap[title] = [];
        }
        titleMap[title].push(url);
      }

      // Track descriptions (skip empty ones as they're already reported)
      if (page.description?.trim()) {
        const description = page.description.trim();
        if (!descriptionMap[description]) {
          descriptionMap[description] = [];
        }
        descriptionMap[description].push(url);
      }
    }

    // Find and report duplicate titles
    let duplicateTitleCount = 0;
    const duplicateTitles = new Map();

    for (const title in titleMap) {
      const urls = titleMap[title];
      if (urls.length > 1) {
        duplicateTitleCount++;
        duplicateTitles.set(title, urls);

        const urlList = formatUrlList(urls);
        issues.push({
          title: `Duplicate page titles found`,
          description: `The title "${title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}" is used on ${urls.length} pages:<ul>${urlList}</ul>`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Find and report duplicate descriptions
    let duplicateDescriptionCount = 0;
    const duplicateDescriptions = new Map();

    for (const description in descriptionMap) {
      const urls = descriptionMap[description];
      if (urls.length > 1) {
        duplicateDescriptionCount++;
        duplicateDescriptions.set(description, urls);

        const urlList = formatUrlList(urls);
        issues.push({
          title: `Duplicate meta descriptions found`,
          description: `The description "${description.substring(0, 100).replace(/</g, '&lt;').replace(/>/g, '&gt;')}${description.length > 100 ? '...' : ''}" is used on ${urls.length} pages:<ul>${urlList}</ul>`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    if (duplicateTitleCount > 0) {
      console.log(`Found ${duplicateTitleCount} duplicate titles`);
    }
    if (duplicateDescriptionCount > 0) {
      console.log(`Found ${duplicateDescriptionCount} duplicate descriptions`);
    }
    if (duplicateTitleCount === 0 && duplicateDescriptionCount === 0) {
      console.log('No duplicate titles or descriptions found');
    }

    return {
      duplicateTitles,
      duplicateDescriptions,
      issues,
    };
  }
}

export { DuplicateChecker };
