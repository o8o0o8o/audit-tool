import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

/**
 * Site-wide Social Media Validator
 * Analyzes social media tag implementation across all pages.
 */
class SocialMediaValidator {
  /**
   * Validate social media implementation across all pages.
   *
   * @param {Object} allPages - Object containing all page data { url: pageData }
   * @returns {Object} { issues: [], warnings: [], coverageStats: {} }
   */
  static validateSocialMediaImplementation(allPages: Record<string, PageInfo>) {
    console.log('\nAnalyzing social media tag implementation across pages...');

    const socialStats = {
      pagesWithOpenGraph: 0,
      pagesWithTwitterCard: 0,
      pagesWithoutSocial: 0,
      socialImages: new Map(), // image URL -> count
      missingOgImage: [] as string[],
      missingTwitterCard: [] as string[],
      relativeImageUrls: [] as Record<string, any>[],
      imageDimensionIssues: [] as Record<string, any>[],
      totalIssues: 0,
      totalWarnings: 0,
    };

    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    let pagesAnalyzed = 0;

    // Analyze each page's social media data
    for (const url in allPages) {
      const page = allPages[url];

      if (!page.socialMedia) continue;

      pagesAnalyzed++;
      const socialData = page.socialMedia;

      // Track coverage
      if (socialData.hasOpenGraph) {
        socialStats.pagesWithOpenGraph++;
      }

      if (socialData.hasTwitterCard) {
        socialStats.pagesWithTwitterCard++;
      }

      if (!socialData.hasOpenGraph && !socialData.hasTwitterCard) {
        socialStats.pagesWithoutSocial++;
      }

      // Track social images
      const ogImage = socialData.openGraph?.['og:image'];
      if (ogImage) {
        socialStats.socialImages.set(ogImage, (socialStats.socialImages.get(ogImage) || 0) + 1);

        // Check for relative URLs
        if (!ogImage.startsWith('http')) {
          socialStats.relativeImageUrls.push({ url, image: ogImage });
        }

        // Check dimensions
        const width = parseInt(socialData.openGraph?.['og:image:width'], 10) || 0;
        const height = parseInt(socialData.openGraph?.['og:image:height'], 10) || 0;
        if (width > 0 && height > 0 && (width < 1200 || height < 630)) {
          socialStats.imageDimensionIssues.push({
            url,
            image: ogImage,
            dimensions: `${width}x${height}`,
          });
        }
      } else {
        socialStats.missingOgImage.push(url);
      }

      if (!socialData.hasTwitterCard) {
        socialStats.missingTwitterCard.push(url);
      }

      // Count issues and warnings
      socialStats.totalIssues += socialData.issues?.length || 0;
      socialStats.totalWarnings += socialData.warnings?.length || 0;
    }

    const ogCoverage = pagesAnalyzed > 0 ? Math.round((socialStats.pagesWithOpenGraph / pagesAnalyzed) * 100) : 0;
    const twitterCoverage =
      pagesAnalyzed > 0 ? Math.round((socialStats.pagesWithTwitterCard / pagesAnalyzed) * 100) : 0;

    console.log(`Open Graph coverage: ${socialStats.pagesWithOpenGraph}/${pagesAnalyzed} pages (${ogCoverage}%)`);
    console.log(
      `Twitter Card coverage: ${socialStats.pagesWithTwitterCard}/${pagesAnalyzed} pages (${twitterCoverage}%)`,
    );

    // Report 1: Low Open Graph coverage
    if (ogCoverage < 80 && pagesAnalyzed > 10) {
      issues.push({
        title: `Low Open Graph tag coverage`,
        description: `Only ${ogCoverage}% of pages (${socialStats.pagesWithOpenGraph}/${pagesAnalyzed}) have Open Graph tags. This affects Facebook, LinkedIn, and WhatsApp sharing.`,
        severity: SEVERITY.HIGH,
      });
    }

    // Report 2: Pages without any social tags
    if (socialStats.pagesWithoutSocial > 0) {
      const pagesWithoutList = Object.keys(allPages)
        .filter((url) => {
          const page = allPages[url];
          return page.socialMedia && !page.socialMedia.hasOpenGraph && !page.socialMedia.hasTwitterCard;
        })
        .slice(0, 10)
        .map((url) => `<li><a href="${url}">${url}</a></li>`)
        .join('');
      const moreCount = socialStats.pagesWithoutSocial > 10 ? ` (showing 10 of ${socialStats.pagesWithoutSocial})` : '';

      issues.push({
        title: `Pages missing social media tags`,
        description: `${socialStats.pagesWithoutSocial} page(s) have no social media tags (Open Graph or Twitter Card)${moreCount}:<ul>${pagesWithoutList}</ul>`,
        severity: SEVERITY.HIGH,
      });
    }

    // Report 3: Default social image usage (same image on many pages)
    const imageUsage = Array.from(socialStats.socialImages.entries()).sort((a, b) => b[1] - a[1]);

    if (imageUsage.length > 0 && imageUsage[0][1] > pagesAnalyzed * 0.7) {
      issues.push({
        title: `Default social image used on most pages`,
        description: `The same Open Graph image is used on ${imageUsage[0][1]} pages (${Math.round((imageUsage[0][1] / pagesAnalyzed) * 100)}%). Consider using unique images for each page: ${imageUsage[0][0]}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Report 4: Relative image URLs (will break social sharing)
    if (socialStats.relativeImageUrls.length > 0) {
      const relativeList = socialStats.relativeImageUrls
        .slice(0, 5)
        .map((item) => `<li><a href="${item.url}">${item.url}</a> - ${item.image}</li>`)
        .join('');

      issues.push({
        title: `Social images use relative URLs`,
        description: `${socialStats.relativeImageUrls.length} page(s) have relative URLs in og:image or twitter:image. These must be absolute URLs:<ul>${relativeList}</ul>`,
        severity: SEVERITY.CRITICAL,
      });
    }

    // Report 5: Image dimension issues
    if (socialStats.imageDimensionIssues.length > 5) {
      const dimensionList = socialStats.imageDimensionIssues
        .slice(0, 5)
        .map((item) => `<li><a href="${item.url}">${item.url}</a> - ${item.dimensions} (recommended: 1200x630)</li>`)
        .join('');

      issues.push({
        title: `Social images below recommended dimensions`,
        description: `${socialStats.imageDimensionIssues.length} page(s) have social images smaller than the recommended 1200x630:<ul>${dimensionList}</ul>`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Report 6: Missing Twitter Cards but have Open Graph
    const missingTwitterButHaveOG = Object.keys(allPages).filter((url) => {
      const page = allPages[url];
      return page.socialMedia && page.socialMedia.hasOpenGraph && !page.socialMedia.hasTwitterCard;
    });

    if (missingTwitterButHaveOG.length > pagesAnalyzed * 0.5) {
      warnings.push({
        title: `Many pages missing Twitter Card tags`,
        description: `${missingTwitterButHaveOG.length} page(s) have Open Graph but no Twitter Card tags. While Twitter falls back to OG, explicit Twitter tags provide better control.`,
        severity: SEVERITY.LOW,
      });
    }

    console.log(`Unique social images: ${socialStats.socialImages.size}`);
    console.log(`Total social media issues: ${socialStats.totalIssues}`);

    return {
      issues,
      warnings,
      coverageStats: {
        ogCoverage,
        twitterCoverage,
        pagesWithOpenGraph: socialStats.pagesWithOpenGraph,
        pagesWithTwitterCard: socialStats.pagesWithTwitterCard,
        pagesWithoutSocial: socialStats.pagesWithoutSocial,
        totalPages: pagesAnalyzed,
        uniqueSocialImages: socialStats.socialImages.size,
        mostUsedImage: imageUsage[0] ? { url: imageUsage[0][0], count: imageUsage[0][1] } : null,
        totalIssues: socialStats.totalIssues,
        totalWarnings: socialStats.totalWarnings,
      },
    };
  }
}

export { SocialMediaValidator };
