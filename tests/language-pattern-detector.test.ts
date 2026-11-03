import { describe, it } from 'node:test';
import assert from 'node:assert';

import { detectLanguagePatternsInUrls } from '../lib/orchestrators/language-pattern-detector';
import type { SitemapUrl } from '../lib/types';

function urlMap(urls: string[]): Record<string, SitemapUrl> {
  const map: Record<string, SitemapUrl> = {};
  for (const u of urls) map[u] = { loc: u };
  return map;
}

void describe('detectLanguagePatternsInUrls: language code nested behind a prefix segment', () => {
  void it("detects /lang/<code>/ (semver.org's real sitemap shape) — the bug: only the first path segment was checked", () => {
    const result = detectLanguagePatternsInUrls(
      urlMap([
        'https://semver.org/lang/nl/',
        'https://semver.org/lang/cs/',
        'https://semver.org/lang/ar/',
        'https://semver.org/lang/de/',
      ]),
    );
    assert.strictEqual(result.isMultiLang, true);
    assert.ok(result.languages.includes('nl'));
    assert.ok(result.languages.includes('de'));
  });

  void it('still detects a bare /<code>/ at the root (no regression)', () => {
    const result = detectLanguagePatternsInUrls(
      urlMap(['https://example.com/en/page', 'https://example.com/de/page', 'https://example.com/fr/page']),
    );
    assert.strictEqual(result.isMultiLang, true);
  });

  void it('detects a language + region segment (en-us) regardless of nesting depth', () => {
    const result = detectLanguagePatternsInUrls(
      urlMap(['https://example.com/store/en-us/', 'https://example.com/store/de-de/']),
    );
    assert.strictEqual(result.isMultiLang, true);
  });

  void it('does not flag a single-language site with only one matching segment', () => {
    const result = detectLanguagePatternsInUrls(urlMap(['https://example.com/lang/en/', 'https://example.com/about']));
    assert.strictEqual(result.isMultiLang, false);
  });

  void it('does not flag an unrelated two-letter path segment that is not a real language code', () => {
    const result = detectLanguagePatternsInUrls(
      urlMap(['https://example.com/api/v2/', 'https://example.com/us/store/']),
    );
    assert.strictEqual(result.isMultiLang, false);
  });

  void it('does not treat ordinary nested 2-letter slugs as languages (/product/id, /category/it, /blog/no)', () => {
    const result = detectLanguagePatternsInUrls(
      urlMap([
        'https://example.com/product/id/123',
        'https://example.com/category/it/',
        'https://example.com/blog/no/',
      ]),
    );
    assert.strictEqual(result.isMultiLang, false);
  });

  void it('each cited false-positive shape stays single-language when paired with an unrelated URL', () => {
    for (const extra of [
      'https://example.com/product/id/123',
      'https://example.com/category/it/',
      'https://example.com/blog/no/',
    ]) {
      const result = detectLanguagePatternsInUrls(urlMap([extra, 'https://example.com/about']));
      assert.strictEqual(result.isMultiLang, false, extra);
    }
  });
});
