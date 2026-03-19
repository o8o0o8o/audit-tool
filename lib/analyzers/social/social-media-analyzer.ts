import type { ChromePage, ParsedPage } from '../../types';

class SocialMediaAnalyzer {
  static async analyzeSocialMediaTags(chromePage: ChromePage, parsedPage: ParsedPage, url: string) {
    const socialData = {
      hasOpenGraph: false,
      hasTwitterCard: false,
      openGraph: {} as Record<string, string | null>,
      twitterCard: {} as Record<string, string | null>,
      issues: [] as string[],
      warnings: [] as string[],
    };

    // Extract Open Graph tags
    const ogTags: Record<string, string | null> = {
      'og:title': null,
      'og:description': null,
      'og:image': null,
      'og:url': null,
      'og:type': null,
      'og:site_name': null,
      'og:locale': null,
      'og:image:width': null,
      'og:image:height': null,
      'og:image:alt': null,
    };

    for (const property in ogTags) {
      const tag = parsedPage.querySelector(`meta[property="${property}"]`);
      if (tag) {
        ogTags[property] = tag.getAttribute('content') ?? null;
        socialData.hasOpenGraph = true;
      }
    }

    socialData.openGraph = ogTags;

    // Extract Twitter Card tags
    const twitterTags: Record<string, string | null> = {
      'twitter:card': null,
      'twitter:title': null,
      'twitter:description': null,
      'twitter:image': null,
      'twitter:image:alt': null,
      'twitter:site': null,
      'twitter:creator': null,
    };

    for (const name in twitterTags) {
      const tag = parsedPage.querySelector(`meta[name="${name}"]`);
      if (tag) {
        twitterTags[name] = tag.getAttribute('content') ?? null;
        socialData.hasTwitterCard = true;
      }
    }

    socialData.twitterCard = twitterTags;

    // Validation 1: Check required Open Graph tags
    if (!ogTags['og:title']) {
      socialData.issues.push('Missing og:title (required for Facebook sharing)');
    } else if (ogTags['og:title'].length > 60) {
      socialData.warnings.push(`og:title is ${ogTags['og:title'].length} chars (recommended: <60 chars)`);
    }

    if (!ogTags['og:description']) {
      socialData.issues.push('Missing og:description (required for Facebook sharing)');
    } else if (ogTags['og:description'].length > 200) {
      socialData.warnings.push(`og:description is ${ogTags['og:description'].length} chars (recommended: <200 chars)`);
    }

    if (!ogTags['og:image']) {
      socialData.issues.push('Missing og:image (required for visual Facebook sharing)');
    } else {
      // Validate image dimensions if provided
      const width = parseInt(ogTags['og:image:width']!, 10) || 0;
      const height = parseInt(ogTags['og:image:height']!, 10) || 0;

      if (!ogTags['og:image:width'] || !ogTags['og:image:height']) {
        socialData.warnings.push('Missing og:image:width or og:image:height (recommended for optimization)');
      } else if (width < 1200 || height < 630) {
        socialData.warnings.push(`og:image dimensions (${width}x${height}) below recommended 1200x630`);
      }

      if (!ogTags['og:image:alt']) {
        socialData.warnings.push('Missing og:image:alt (important for accessibility)');
      }
    }

    if (!ogTags['og:url']) {
      socialData.warnings.push('Missing og:url (helps prevent duplicate content in social platforms)');
    } else if (ogTags['og:url'] !== url && !ogTags['og:url'].includes(url.split('?')[0])) {
      socialData.warnings.push(`og:url (${ogTags['og:url']}) doesn't match page URL`);
    }

    if (!ogTags['og:type']) {
      socialData.warnings.push('Missing og:type (helps social platforms understand content type)');
    }

    // Validation 2: Check Twitter Card tags
    if (!twitterTags['twitter:card']) {
      socialData.issues.push('Missing twitter:card (required for Twitter sharing)');
    } else {
      const validCards = ['summary', 'summary_large_image', 'app', 'player'];
      if (!validCards.includes(twitterTags['twitter:card'])) {
        socialData.issues.push(
          `Invalid twitter:card value: ${twitterTags['twitter:card']} (must be: ${validCards.join(', ')})`,
        );
      }
    }

    if (!twitterTags['twitter:title']) {
      socialData.warnings.push('Missing twitter:title (falls back to og:title, but explicit is better)');
    } else if (twitterTags['twitter:title'].length > 70) {
      socialData.warnings.push(
        `twitter:title is ${twitterTags['twitter:title'].length} chars (recommended: <70 chars)`,
      );
    }

    if (!twitterTags['twitter:description']) {
      socialData.warnings.push('Missing twitter:description (falls back to og:description)');
    } else if (twitterTags['twitter:description'].length > 200) {
      socialData.warnings.push(
        `twitter:description is ${twitterTags['twitter:description'].length} chars (recommended: <200 chars)`,
      );
    }

    if (!twitterTags['twitter:image']) {
      socialData.warnings.push('Missing twitter:image (falls back to og:image)');
    }

    if (!twitterTags['twitter:site'] && !twitterTags['twitter:creator']) {
      socialData.warnings.push('Missing twitter:site and twitter:creator (helps with attribution)');
    }

    // Validation 3: Check consistency between regular meta tags and social tags
    const pageTitle = parsedPage.querySelector('title')?.textContent;
    const pageDescription = parsedPage.querySelector('meta[name="description"]')?.getAttribute('content');

    if (pageTitle && ogTags['og:title'] && pageTitle !== ogTags['og:title']) {
      socialData.warnings.push('og:title differs from page <title> (may be intentional)');
    }

    if (pageDescription && ogTags['og:description'] && pageDescription !== ogTags['og:description']) {
      socialData.warnings.push('og:description differs from meta description (may be intentional)');
    }

    // Validation 4: Check image URLs are absolute
    if (ogTags['og:image'] && !ogTags['og:image'].startsWith('http')) {
      socialData.issues.push('og:image must be an absolute URL (starting with http:// or https://)');
    }

    if (twitterTags['twitter:image'] && !twitterTags['twitter:image'].startsWith('http')) {
      socialData.issues.push('twitter:image must be an absolute URL (starting with http:// or https://)');
    }

    return socialData;
  }
}

export { SocialMediaAnalyzer };
