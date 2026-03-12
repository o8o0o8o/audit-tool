import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

/**
 * Site-wide Structured Data Validator
 * Analyzes structured data consistency across all pages.
 */
class StructuredDataValidator {
  /**
   * Validate structured data consistency across all pages.
   *
   * @param {Object} allPages - Object containing all page data { url: pageData }
   * @returns {Object} { issues: [], stats: {}, organizationSchemas: [], websiteSchemas: [], ... }
   */
  static validateStructuredDataConsistency(allPages: Record<string, PageInfo>) {
    console.log('\nChecking structured data consistency across pages...');

    const schemaStats = {
      pagesWithSchema: 0,
      pagesWithoutSchema: 0,
      schemaTypes: new Map(), // type -> count
      organizationSchemas: [] as {
        url: string;
        name: unknown;
        type?: string;
        schema: Record<string, unknown> | undefined;
      }[],
      websiteSchemas: [] as { url: string; name: unknown; schema: Record<string, unknown> | undefined }[],
      articlePages: [] as string[],
      productPages: [] as string[],
      duplicateArticles: new Map(), // headline -> URLs
      duplicateProducts: new Map(), // product name -> URLs
    };

    const issues: Issue[] = [];

    // Analyze structured data across all pages
    for (const url in allPages) {
      const page = allPages[url];

      if (!page.structuredData || !page.structuredData.hasStructuredData) {
        schemaStats.pagesWithoutSchema++;
        continue;
      }

      schemaStats.pagesWithSchema++;

      // Analyze each schema type
      for (const schema of page.structuredData.jsonLdSchemas || []) {
        const type = schema.type;

        // Count schema types
        schemaStats.schemaTypes.set(type, (schemaStats.schemaTypes.get(type) || 0) + 1);

        // Collect Organization schemas for consistency check
        if (type === 'Organization' || type === 'LocalBusiness') {
          schemaStats.organizationSchemas.push({
            url,
            name: schema.raw?.name,
            type,
            schema: schema.raw,
          });
        }

        // Collect WebSite schemas
        if (type === 'WebSite') {
          schemaStats.websiteSchemas.push({
            url,
            name: schema.raw?.name,
            schema: schema.raw,
          });
        }

        // Track Article schemas (check for duplicates)
        if (type === 'Article' || type === 'NewsArticle' || type === 'BlogPosting') {
          const headline = schema.raw?.headline;
          if (headline) {
            if (!schemaStats.duplicateArticles.has(headline)) {
              schemaStats.duplicateArticles.set(headline, []);
            }
            schemaStats.duplicateArticles.get(headline).push(url);
          }
          schemaStats.articlePages.push(url);
        }

        // Track Product schemas (check for duplicates)
        if (type === 'Product') {
          const productName = schema.raw?.name;
          if (productName) {
            if (!schemaStats.duplicateProducts.has(productName)) {
              schemaStats.duplicateProducts.set(productName, []);
            }
            schemaStats.duplicateProducts.get(productName).push(url);
          }
          schemaStats.productPages.push(url);
        }
      }
    }

    // Report findings
    const totalPages = Object.keys(allPages).length;
    const coveragePercent = totalPages > 0 ? Math.round((schemaStats.pagesWithSchema / totalPages) * 100) : 0;

    console.log(`Structured data coverage: ${schemaStats.pagesWithSchema}/${totalPages} pages (${coveragePercent}%)`);
    console.log(`Schema types found: ${Array.from(schemaStats.schemaTypes.keys()).join(', ')}`);

    // Check 1: Organization schema consistency
    if (schemaStats.organizationSchemas.length > 1) {
      // Check if all Organization schemas have the same name
      const orgNames = new Set(schemaStats.organizationSchemas.map((o) => o.name).filter(Boolean));

      if (orgNames.size > 1) {
        const nameList = Array.from(orgNames)
          .map((name) => `<li>"${name}"</li>`)
          .join('');
        issues.push({
          title: `Inconsistent Organization schema across pages`,
          description: `${orgNames.size} different organization names found in structured data. Organization schema should be consistent site-wide:<ul>${nameList}</ul>`,
          severity: SEVERITY.MEDIUM,
        });
      }

      // Check if Organization appears on most pages (it should be site-wide)
      if (schemaStats.organizationSchemas.length < schemaStats.pagesWithSchema * 0.5) {
        issues.push({
          title: `Organization schema not present on all pages`,
          description: `Organization schema found on only ${schemaStats.organizationSchemas.length} out of ${schemaStats.pagesWithSchema} pages with structured data. Consider adding it site-wide for better brand recognition.`,
          severity: SEVERITY.LOW,
        });
      }
    } else if (schemaStats.organizationSchemas.length === 0 && schemaStats.pagesWithSchema > 0) {
      issues.push({
        title: `No Organization schema found`,
        description: `No Organization or LocalBusiness schema detected on any page. Adding this helps search engines understand your brand.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check 2: WebSite schema (should only appear once, typically on homepage)
    if (schemaStats.websiteSchemas.length > 1) {
      const urlList = schemaStats.websiteSchemas.map((w) => `<li><a href="${w.url}">${w.url}</a></li>`).join('');
      issues.push({
        title: `WebSite schema appears on multiple pages`,
        description: `WebSite schema found on ${schemaStats.websiteSchemas.length} pages. It should typically only appear on the homepage:<ul>${urlList}</ul>`,
        severity: SEVERITY.LOW,
      });
    }

    // Check 3: Duplicate Article headlines
    let duplicateArticleCount = 0;
    for (const [headline, urls] of schemaStats.duplicateArticles) {
      if (urls.length > 1) {
        duplicateArticleCount++;
        const urlList = urls.map((url: string) => `<li><a href="${url}">${url}</a></li>`).join('');
        issues.push({
          title: `Duplicate Article schema with same headline`,
          description: `Article headline "${headline}" appears on ${urls.length} different pages:<ul>${urlList}</ul>`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Check 4: Duplicate Product names
    let duplicateProductCount = 0;
    for (const [productName, urls] of schemaStats.duplicateProducts) {
      if (urls.length > 1) {
        duplicateProductCount++;
        const urlList = urls.map((url: string) => `<li><a href="${url}">${url}</a></li>`).join('');
        issues.push({
          title: `Duplicate Product schema with same name`,
          description: `Product name "${productName}" appears on ${urls.length} different pages:<ul>${urlList}</ul>`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Check 5: Low schema coverage
    if (coveragePercent < 50 && totalPages > 10) {
      issues.push({
        title: `Low structured data coverage`,
        description: `Only ${coveragePercent}% of pages (${schemaStats.pagesWithSchema}/${totalPages}) have structured data. Consider adding schema markup to more pages for better SEO.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Summary
    if (duplicateArticleCount > 0) {
      console.log(`Found ${duplicateArticleCount} duplicate article headlines`);
    }
    if (duplicateProductCount > 0) {
      console.log(`Found ${duplicateProductCount} duplicate product names`);
    }

    return {
      issues,
      stats: {
        coverage: coveragePercent,
        pagesWithSchema: schemaStats.pagesWithSchema,
        pagesWithoutSchema: schemaStats.pagesWithoutSchema,
        totalPages: totalPages,
        schemaTypes: Array.from(schemaStats.schemaTypes.entries()).map(([type, count]) => ({ type, count })),
        articleCount: schemaStats.articlePages.length,
        productCount: schemaStats.productPages.length,
        organizationCount: schemaStats.organizationSchemas.length,
      },
      organizationSchemas: schemaStats.organizationSchemas,
      websiteSchemas: schemaStats.websiteSchemas,
      articlePages: schemaStats.articlePages,
      productPages: schemaStats.productPages,
    };
  }
}

export { StructuredDataValidator };
