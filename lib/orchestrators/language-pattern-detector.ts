import type { SitemapUrl } from '../types';

// Common language codes (ISO 639-1)
const LANG_CODES = new Set([
  'en',
  'de',
  'fr',
  'es',
  'it',
  'pt',
  'nl',
  'pl',
  'ru',
  'ja',
  'ko',
  'zh',
  'ar',
  'he',
  'hi',
  'th',
  'vi',
  'id',
  'ms',
  'tr',
  'sv',
  'da',
  'no',
  'fi',
  'cs',
  'hu',
  'ro',
  'bg',
  'uk',
  'el',
  'sk',
  'sl',
  'hr',
  'sr',
  'lt',
  'lv',
  'et',
  'ca',
  'eu',
  'gl',
  'cy',
  'ga',
  'mt',
  'is',
  'mk',
  'sq',
  'bs',
]);

const LANG_REGION_SEGMENT = /^([a-z]{2})(-[a-z]{2})?$/i;
const LOCALE_PREFIX_SEGMENTS = new Set(['lang', 'locale', 'language', 'i18n', 'l']);

export function detectLanguagePatternsInUrls(urls: Record<string, SitemapUrl>): {
  isMultiLang: boolean;
  languages: string[];
} {
  const detectedLanguages = new Set<string>();
  let urlsChecked = 0;
  const maxUrlsToCheck = 100;

  for (const url in urls) {
    if (urlsChecked >= maxUrlsToCheck) break;
    urlsChecked++;

    try {
      const parsed = new URL(url);

      const segments = parsed.pathname.split('/').filter(Boolean);
      for (let i = 0; i < segments.length && i <= 1; i++) {
        const segMatch = segments[i].match(LANG_REGION_SEGMENT);
        if (!segMatch || !LANG_CODES.has(segMatch[1].toLowerCase())) continue;
        const isRegionTagged = Boolean(segMatch[2]);
        const parent = i > 0 ? segments[i - 1] : undefined;
        if (i === 0 || isRegionTagged || (parent != null && LOCALE_PREFIX_SEGMENTS.has(parent.toLowerCase()))) {
          detectedLanguages.add(segMatch[1].toLowerCase());
        }
      }

      const hostParts = parsed.hostname.split('.');
      if (hostParts.length >= 2) {
        const subdomain = hostParts[0].toLowerCase();
        if (LANG_CODES.has(subdomain) && subdomain !== 'www') {
          detectedLanguages.add(subdomain);
        }
      }
    } catch {
      continue;
    }
  }

  return {
    isMultiLang: detectedLanguages.size >= 2,
    languages: Array.from(detectedLanguages),
  };
}
