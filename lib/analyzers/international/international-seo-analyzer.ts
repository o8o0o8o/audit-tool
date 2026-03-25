import { getHeader, normalizeUrlForComparison } from '../../utils';
import type { ChromePage, ParsedPage } from '../../types';

class InternationalSEOAnalyzer {
  static async analyzeInternationalSEO(
    chromePage: ChromePage,
    parsedPage: ParsedPage,
    url: string,
    responseHeaders: Record<string, string> = {},
  ) {
    const intlData: {
      language: string | null;
      region: string | null;
      hasLangAttribute: boolean;
      langAttribute: string | null;
      contentLanguageHeader: string | null;
      hasHreflang: boolean;
      hasXDefault: boolean;
      hasSelfReferential: boolean;
      urlStructure: string | null;
      charset: string | null;
      issues: string[];
      warnings: string[];
      currencyDetected?: string;
      hasDateFormat?: boolean;
      detectedScript?: string;
    } = {
      language: null,
      region: null,
      hasLangAttribute: false,
      langAttribute: null,
      contentLanguageHeader: null,
      hasHreflang: false,
      hasXDefault: false,
      hasSelfReferential: false,
      urlStructure: null, // subdomain, subdirectory, or tld
      charset: null,
      issues: [],
      warnings: [],
    };

    // 1. Check HTML lang attribute
    const htmlLang = parsedPage.querySelector('html')?.getAttribute('lang');
    if (htmlLang) {
      intlData.hasLangAttribute = true;
      intlData.langAttribute = htmlLang;

      // Parse language and region (e.g., "en-US" -> language: "en", region: "US")
      const parts = htmlLang.split('-');
      intlData.language = parts[0].toLowerCase();
      if (parts.length > 1) {
        intlData.region = parts[1].toUpperCase();
      }

      // Validate language code (basic ISO 639-1 check)
      if (intlData.language.length !== 2 && intlData.language.length !== 3) {
        intlData.issues.push(`Invalid language code: ${intlData.language}`);
      }
    } else {
      intlData.issues.push('Missing lang attribute on <html> tag');
    }

    // 2. Check Content-Language HTTP header (use pre-captured headers)
    const headers = responseHeaders || {};
    const contentLanguage = getHeader(headers, 'content-language');
    if (contentLanguage) {
      intlData.contentLanguageHeader = contentLanguage ?? null;

      // Check consistency with HTML lang
      if (htmlLang && contentLanguage.toLowerCase() !== htmlLang.toLowerCase()) {
        intlData.warnings.push(
          `Content-Language header (${contentLanguage}) doesn't match HTML lang attribute (${htmlLang})`,
        );
      }
    }

    // 3. Check charset
    const metaCharset = parsedPage.querySelector('meta[charset]');
    const metaContentType = parsedPage.querySelector('meta[http-equiv="Content-Type"]');

    if (metaCharset) {
      intlData.charset = metaCharset.getAttribute('charset') ?? null;
    } else if (metaContentType) {
      const content = metaContentType.getAttribute('content') ?? '';
      const match = content.match(/charset=([^;]+)/i);
      if (match) {
        intlData.charset = match[1];
      }
    }

    if (!intlData.charset) {
      intlData.issues.push('Missing charset declaration');
    } else if (intlData.charset.toLowerCase() !== 'utf-8') {
      intlData.warnings.push(`Charset is ${intlData.charset}, UTF-8 is recommended for international sites`);
    }

    // 4. Check hreflang implementation
    const hreflangLinks = parsedPage.querySelectorAll('link[rel="alternate"][hreflang]');
    if (hreflangLinks.length > 0) {
      intlData.hasHreflang = true;

      // Check for x-default
      for (const link of hreflangLinks) {
        const hreflang = link.getAttribute('hreflang');
        const href = link.getAttribute('href');

        if (hreflang === 'x-default') {
          intlData.hasXDefault = true;
        }

        // Check for self-referential hreflang
        if (href === url || normalizeUrlForComparison(href!) === normalizeUrlForComparison(url)) {
          intlData.hasSelfReferential = true;
        }

        // Validate hreflang format (language or language-region)
        if (hreflang !== 'x-default') {
          const hreflangParts = hreflang!.split('-');
          if (hreflangParts.length > 2) {
            intlData.warnings.push(`Invalid hreflang format: ${hreflang} (should be language or language-region)`);
          }
        }
      }

      // Warn if no x-default for multi-language sites
      if (hreflangLinks.length > 1 && !intlData.hasXDefault) {
        intlData.warnings.push('Missing x-default hreflang for multi-language site');
      }

      // Warn if no self-referential hreflang
      if (!intlData.hasSelfReferential) {
        intlData.warnings.push('Missing self-referential hreflang (page should reference itself)');
      }
    }

    // 5. Detect URL structure for international sites
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      const pathname = urlObj.pathname;

      // Check for ccTLD (country-code top-level domain)
      // Generic 2-letter TLDs commonly used as non-country domains
      const genericTLDs = new Set([
        'com',
        'org',
        'net',
        'io',
        'co',
        'ai',
        'me',
        'tv',
        'gg',
        'fm',
        'am',
        'sh',
        'to',
        'ly',
        'st',
        'ms',
        'cc',
        'ws',
      ]);
      const tldMatch = hostname.match(/\.([a-z]{2})$/i);
      if (tldMatch && !genericTLDs.has(tldMatch[1].toLowerCase())) {
        intlData.urlStructure = 'tld';
      }
      // Check for subdomain (e.g., fr.example.com, en.example.com)
      else if (hostname.split('.').length > 2) {
        const subdomain = hostname.split('.')[0];
        if (subdomain.length === 2 || subdomain.match(/^(en|fr|de|es|it|pt|ja|zh|ko|ru|ar)$/i)) {
          intlData.urlStructure = 'subdomain';
        }
      }
      // Check for subdirectory (e.g., example.com/en/, example.com/fr/)
      else if (pathname.match(/^\/[a-z]{2}(-[A-Z]{2})?(\/|$)/)) {
        intlData.urlStructure = 'subdirectory';
      }
    } catch {
      // Invalid URL, skip structure detection
    }

    // 6. Check for language switcher
    const languageSwitcher = parsedPage.querySelector(
      '[class*="lang"], [id*="lang"], [class*="language"], select[name*="lang"]',
    );
    if (!languageSwitcher && intlData.hasHreflang) {
      intlData.warnings.push('No visible language switcher found (user experience issue)');
    }

    // 7. Check for localized content signals
    const bodyText = parsedPage.querySelector('body')?.textContent ?? '';

    // Check for currency symbols (localization signal)
    const currencies = {
      $: 'USD/AUD/CAD',
      '€': 'EUR',
      '£': 'GBP',
      '¥': 'JPY/CNY',
      '₹': 'INR',
      '₽': 'RUB',
      R$: 'BRL',
    };

    for (const [symbol, currency] of Object.entries(currencies)) {
      if (bodyText.includes(symbol)) {
        intlData.currencyDetected = currency;
        break;
      }
    }

    // 8. Check for date format indicators (localization signal)
    if (bodyText.match(/\d{1,2}\/\d{1,2}\/\d{4}/)) {
      intlData.hasDateFormat = true;
    }

    // 9. Content language detection (basic heuristic)
    const metaDescription = parsedPage.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
    const title = parsedPage.querySelector('title')?.textContent ?? '';
    const sampleText = (title + ' ' + metaDescription).toLowerCase();

    // Detect common non-Latin scripts
    if (sampleText.match(/[\u0400-\u04FF]/)) {
      intlData.detectedScript = 'Cyrillic';
    } else if (sampleText.match(/[\u0600-\u06FF]/)) {
      intlData.detectedScript = 'Arabic';
    } else if (sampleText.match(/[\u4E00-\u9FFF]/)) {
      intlData.detectedScript = 'Chinese';
    } else if (sampleText.match(/[\u3040-\u309F\u30A0-\u30FF]/)) {
      intlData.detectedScript = 'Japanese';
    } else if (sampleText.match(/[\uAC00-\uD7AF]/)) {
      intlData.detectedScript = 'Korean';
    } else if (sampleText.match(/[\u0E00-\u0E7F]/)) {
      intlData.detectedScript = 'Thai';
    } else if (sampleText.match(/[\u0900-\u097F]/)) {
      intlData.detectedScript = 'Devanagari';
    }

    return intlData;
  }
}

export { InternationalSEOAnalyzer };
