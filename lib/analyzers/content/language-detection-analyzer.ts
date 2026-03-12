/**
 * Language Detection Analyzer
 * Detects the actual language of page content using trigram analysis
 * and compares it with the declared html lang attribute and Content-Language header.
 */

import { SEVERITY } from '../../constants';
import type { Issue, ChromePage, ParsedPage, PageInfo } from '../../types';

// Trigram language profiles - top trigrams for common languages
// Based on frequency analysis of large text corpora
const LANGUAGE_PROFILES = {
  en: [
    ' th',
    'the',
    'he ',
    ' an',
    'nd ',
    'and',
    ' to',
    'ion',
    'tio',
    'to ',
    ' of',
    'ed ',
    'of ',
    ' in',
    'ing',
    'ati',
    'in ',
    'on ',
    ' co',
    'ent',
    'is ',
    're ',
    ' re',
    'hat',
    'at ',
    'es ',
    ' st',
    'or ',
    ' ha',
    'er ',
    ' fo',
    'for',
    'ng ',
    'tha',
    'an ',
    'al ',
    'ons',
    ' is',
    ' on',
    'tion',
    'nt ',
    'st ',
    'as ',
    ' be',
    'll ',
    'le ',
    'ith',
    ' wi',
    'wit',
    'ter',
    'ted',
    'ti ',
    'his',
    'ere',
    'con',
    'her',
    'tha',
  ],
  es: [
    ' de',
    'de ',
    ' la',
    ' en',
    'la ',
    'el ',
    'os ',
    ' el',
    'en ',
    'ón ',
    'ion',
    'ció',
    'aci',
    'ión',
    ' co',
    'es ',
    'as ',
    ' lo',
    'do ',
    'nte',
    'que',
    ' qu',
    ' un',
    'los',
    ' se',
    'se ',
    'con',
    ' es',
    'ent',
    'al ',
    ' al',
    'te ',
    'del',
    ' de',
    ' pa',
    'res',
    'sta',
    'ida',
    'lo ',
    ' re',
    'ado',
    'da ',
    'est',
    'una',
    ' po',
    'ra ',
    ' le',
    'par',
    'an ',
    'men',
    'las',
  ],
  fr: [
    ' de',
    'es ',
    ' le',
    ' la',
    'de ',
    'ent',
    'ion',
    'le ',
    'la ',
    ' et',
    'tion',
    'on ',
    'nt ',
    ' co',
    'les',
    'et ',
    'tio',
    're ',
    ' en',
    'ati',
    'ne ',
    ' qu',
    ' pa',
    'ns ',
    'men',
    'te ',
    'ons',
    'que',
    'emen',
    'des',
    ' le',
    ' de',
    ' un',
    'ait',
    'emen',
    'en ',
    'nce',
    ' pr',
    'an ',
    ' re',
    ' se',
    'par',
    'ant',
    'eur',
    ' po',
    'er ',
    'ance',
    'ce ',
    'emen',
    'ous',
    'pro',
  ],
  de: [
    ' de',
    'en ',
    'er ',
    ' di',
    'die',
    'ie ',
    'der',
    'che',
    ' un',
    'ich',
    'nd ',
    'in ',
    'ein',
    'sch',
    'ein',
    ' ei',
    'ung',
    'gen',
    'ch ',
    'den',
    ' da',
    'eit',
    'ine',
    'te ',
    'ver',
    ' au',
    'und',
    ' ge',
    ' be',
    ' ve',
    'nde',
    'ber',
    'ren',
    'ter',
    ' in',
    ' mi',
    'mit',
    'lic',
    'auf',
    'hen',
    'ige',
    'rde',
    'erd',
    'wer',
    'ist',
    ' is',
    ' we',
    'ste',
    'ach',
    'her',
    'ien',
  ],
  it: [
    ' di',
    'di ',
    ' de',
    'la ',
    'to ',
    'ell',
    'che',
    'ne ',
    ' in',
    ' co',
    're ',
    ' la',
    'del',
    'le ',
    ' il',
    'ion',
    'azi',
    'zio',
    'one',
    ' un',
    'ent',
    ' ch',
    'per',
    ' pe',
    'ta ',
    'ato',
    'li ',
    'lla',
    'te ',
    'con',
    'ment',
    'ti ',
    'in ',
    'nte',
    'il ',
    'no ',
    ' al',
    ' pr',
    'tti',
    'all',
    'lo ',
    ' de',
    ' so',
    'eri',
    'ni ',
    'nto',
    'ri ',
    'na ',
    ' ri',
    'ono',
  ],
  pt: [
    ' de',
    'de ',
    'os ',
    ' co',
    'ão ',
    'do ',
    ' da',
    ' qu',
    ' do',
    ' a ',
    'que',
    'es ',
    'da ',
    'as ',
    ' se',
    'ent',
    'ção',
    'no ',
    'nte',
    'ade',
    ' em',
    'em ',
    'ment',
    'men',
    'ra ',
    ' pa',
    'con',
    'com',
    'par',
    'ara',
    'dos',
    'te ',
    'ção',
    'sta',
    ' no',
    'er ',
    'al ',
    'res',
    'uma',
    'ma ',
    'pro',
    'est',
    'ida',
    'ção',
    ' pr',
    'is ',
    ' es',
    'mos',
    'pre',
    'ção',
  ],
  nl: [
    ' de',
    'de ',
    'en ',
    'an ',
    'et ',
    'het',
    'van',
    ' he',
    ' va',
    ' ee',
    'een',
    'er ',
    ' in',
    'in ',
    ' ge',
    'nde',
    'aar',
    'der',
    ' en',
    'ver',
    'oor',
    'oor',
    'te ',
    ' be',
    ' ve',
    ' da',
    ' me',
    'den',
    ' op',
    ' te',
    'dat',
    ' wo',
    'gen',
    'ij ',
    'ren',
    'sch',
    'cht',
    'nie',
    'ede',
    'zij',
    'ing',
    'nd ',
    'eer',
    'oor',
    'die',
    'len',
    'ige',
    'eit',
    'ond',
    'wor',
  ],
  ru: [
    ' на',
    ' пр',
    ' по',
    'ени',
    'ста',
    ' ко',
    ' в ',
    'ние',
    'ого',
    'ть ',
    ' не',
    'ани',
    'про',
    ' об',
    ' от',
    ' за',
    ' и ',
    'ост',
    'ова',
    'ных',
    'ие ',
    'но ',
    'ных',
    'ска',
    'ных',
    'ной',
    'при',
    'ого',
    ' ра',
    ' ка',
    ' до',
    ' ст',
    'ной',
    'ных',
    'ий ',
    'ие ',
    'ьно',
    'ель',
    'нно',
    'ные',
    'ого',
    'ого',
    'ная',
    'ных',
    'ред',
    'ния',
    ' с ',
    ' ме',
    ' то',
    'ого',
  ],
  ja: [
    'の ',
    'に ',
    'は ',
    'て ',
    'た ',
    'を ',
    'で ',
    'と ',
    'が ',
    'し ',
    'い ',
    'ます',
    'する',
    'から',
    'です',
    'って',
    'ない',
    'れた',
    'した',
    'こと',
    'ある',
    'れる',
    'ている',
    'ない',
    'もの',
    'にな',
    'よう',
    'その',
    'には',
    'ない',
    'くの',
    'いう',
    'った',
    'るこ',
    'てい',
    'ので',
    'つの',
  ],
  zh: [
    '的 ',
    '了 ',
    '是 ',
    '在 ',
    '有 ',
    '和 ',
    '不 ',
    '我 ',
    '人 ',
    '大 ',
    '中 ',
    '上 ',
    '一 ',
    '为 ',
    '这 ',
    '来 ',
    '他 ',
    '到 ',
    '地 ',
    '出 ',
    '会 ',
    '国 ',
    '以 ',
    '年 ',
    '对 ',
    '说 ',
    '就 ',
    '也 ',
    '时 ',
    '个 ',
  ],
};

class LanguageDetectionAnalyzer {
  /**
   * Detect the actual language of page content and compare with declarations
   * @param {object} chromePage - Playwright page object
   * @param {object} parsedPage - Parsed HTML
   * @param {string} url - Page URL
   * @param {object} pageData - Page data (for accessing intl SEO results)
   * @returns {object} Analysis results
   */
  static async analyzeLanguage(chromePage: ChromePage, parsedPage: ParsedPage, url: string, pageData: PageInfo) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    // Extract text content from main content area
    const textContent = await chromePage.evaluate(() => {
      const mainContent = document.querySelector('main, article, [role="main"]') || document.body;
      const clone = mainContent.cloneNode(true);
      (clone as Element)
        .querySelectorAll(
          'script, style, nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], code, pre',
        )
        .forEach((el: any) => el.remove());
      const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      return text.substring(0, 5000); // Limit for performance
    });

    // Get declared language
    const htmlLang = parsedPage?.querySelector('html')?.getAttribute('lang') || null;
    const contentLanguage = (pageData.response?.headers || pageData.responseHeaders || {})['content-language'] || null;
    const declaredLang = htmlLang || contentLanguage || null;

    // Detect language from content
    const detection = LanguageDetectionAnalyzer.#detectLanguage(textContent);

    const info = {
      detectedLanguage: detection.language,
      detectedConfidence: detection.confidence,
      declaredLanguage: declaredLang,
      htmlLang,
      contentLanguageHeader: contentLanguage,
      match: null as boolean | null,
      topCandidates: detection.topCandidates,
    };

    // Compare detected vs declared
    if (declaredLang && detection.language) {
      const declaredPrimary = declaredLang.split('-')[0].toLowerCase();
      const detectedPrimary = detection.language.toLowerCase();

      info.match = declaredPrimary === detectedPrimary;

      if (!info.match && detection.confidence > 0.5) {
        issues.push({
          message: 'Detected content language does not match declared language',
          detail: `<a href="${url}">${url}</a>: Content appears to be "${detection.language}" (${Math.round(detection.confidence * 100)}% confidence) but declared as "${declaredLang}". This can cause search engines to misclassify the page.`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Missing language declaration
    if (!htmlLang && textContent.length > 100) {
      warnings.push({
        message: 'Missing html lang attribute',
        detail: `<a href="${url}">${url}</a> has no lang attribute on the html element. Detected language: "${detection.language || 'unknown'}".`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { info, issues, warnings };
  }

  /**
   * Detect language using trigram frequency analysis
   * @param {string} text - Text to analyze
   * @returns {object} { language, confidence, topCandidates }
   * @private
   */
  static #detectLanguage(text: string) {
    if (!text || text.length < 50) {
      return { language: null, confidence: 0, topCandidates: [] };
    }

    // Generate trigrams from the text
    const normalized = text.toLowerCase().replace(/[0-9]/g, ' ').replace(/\s+/g, ' ');
    const textTrigrams: Record<string, number> = {};
    for (let i = 0; i < normalized.length - 2; i++) {
      const tri = normalized.substring(i, i + 3);
      textTrigrams[tri] = (textTrigrams[tri] || 0) + 1;
    }

    // Sort by frequency and take top 200
    const textProfile = (Object.entries(textTrigrams) as [string, number][])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200)
      .map(([tri]) => tri);

    // Compare against each language profile
    // Use a fixed penalty so shorter profiles (e.g. zh with 30 trigrams) don't get
    // an unfair advantage over longer ones (e.g. en with 55 trigrams).
    const MISS_PENALTY = 100;
    const scores: Record<string, number> = {};
    for (const [lang, profile] of Object.entries(LANGUAGE_PROFILES)) {
      let distance = 0;
      for (let i = 0; i < textProfile.length; i++) {
        const profileIdx = profile.indexOf(textProfile[i]);
        if (profileIdx === -1) {
          distance += MISS_PENALTY;
        } else {
          distance += Math.abs(i - profileIdx);
        }
      }
      scores[lang] = distance;
    }

    // Sort by lowest distance (best match)
    const sorted = (Object.entries(scores) as [string, number][]).sort((a, b) => a[1] - b[1]);
    const topCandidates = sorted.slice(0, 3).map(([lang, score]) => ({
      language: lang,
      score,
      confidence: Math.max(0, 1 - score / (textProfile.length * Object.keys(LANGUAGE_PROFILES).length)),
    }));

    const best = topCandidates[0];
    const secondBest = topCandidates[1];

    // Confidence: how much better is the best match vs second best
    let confidence = 0;
    if (best && secondBest && (secondBest.score as number) > 0) {
      confidence = Math.min(1, ((secondBest.score as number) - (best.score as number)) / (secondBest.score as number));
    }

    return {
      language: best?.language || null,
      confidence: Math.round(confidence * 100) / 100,
      topCandidates,
    };
  }

  /**
   * Site-wide language analysis
   * @param {object} allPages - All page data
   * @returns {object} Site-wide analysis results
   */
  static analyzeSiteWide(allPages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const pages = Object.values(allPages);

    const langMismatches: string[] = [];
    const missingLangAttr: string[] = [];
    const detectedLanguages: Record<string, number> = {};

    for (const page of pages) {
      const langData = page.languageDetection;
      if (!langData) continue;

      if (langData.detectedLanguage) {
        detectedLanguages[langData.detectedLanguage] = (detectedLanguages[langData.detectedLanguage] || 0) + 1;
      }
      if (langData.match === false && langData.detectedConfidence > 0.5) {
        langMismatches.push(page.url);
      }
      if (!langData.htmlLang) {
        missingLangAttr.push(page.url);
      }
    }

    if (langMismatches.length > 0) {
      const examples = langMismatches
        .slice(0, 5)
        .map((u) => `<li><a href="${u}">${u}</a></li>`)
        .join('');
      issues.push({
        title: `${langMismatches.length} page(s) have content language mismatches`,
        description: `The detected content language does not match the declared language:<ul>${examples}</ul>${langMismatches.length > 5 ? `<p>...and ${langMismatches.length - 5} more</p>` : ''}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Mixed language site without proper hreflang
    const langKeys = Object.keys(detectedLanguages);
    if (langKeys.length > 1) {
      const langSummary = langKeys.map((l) => `${l}: ${detectedLanguages[l]} pages`).join(', ');
      warnings.push({
        title: `Site has content in ${langKeys.length} detected languages`,
        description: `Detected languages: ${langSummary}. Ensure proper hreflang implementation for multilingual content.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings };
  }
}

export { LanguageDetectionAnalyzer };
