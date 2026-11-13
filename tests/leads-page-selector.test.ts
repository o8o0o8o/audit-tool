import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evenSample, languagePrefix, selectLeadPages, templateKey, type HomeLink } from '../lib/leads/page-selector';

const HOME = 'https://example.com/';
const u = (path: string) => `https://example.com${path}`;

void describe('lead page selection', () => {
  void it('ignores a leading language segment when naming a template', () => {
    assert.equal(templateKey(u('/')), '/');
    assert.equal(templateKey(u('/pricing')), '/pricing');
    assert.equal(templateKey(u('/blog/post-a')), '/blog/*');
    assert.equal(templateKey(u('/en/blog/2024/post-a')), '/blog/*');
    assert.equal(templateKey(u('/de-de/')), '/');
    assert.equal(templateKey(u('/pt_BR/produkte')), '/produkte');
    assert.equal(templateKey('nonsense'), null);
    assert.equal(languagePrefix('/en-us/x'), 'en-us');
    assert.equal(languagePrefix('/tv/x'), null, 'two letters that are not a language code');
    assert.equal(languagePrefix('/blog'), null);
  });

  void it('takes the homepage, then the navigation in order, then one page per template', () => {
    const homeLinks: HomeLink[] = [
      { url: u('/pricing'), position: 'header' },
      { url: u('/product'), position: 'nav' },
      { url: u('/login'), position: 'header' },
      { url: u('/blog/latest-post'), position: 'main' },
      { url: u('/privacy'), position: 'footer' },
    ];
    const sitemapUrls = [
      ...Array.from({ length: 30 }, (_, i) => u(`/blog/post-${i}`)),
      u('/customers/acme'),
      u('/customers/globex'),
      u('/about'),
      u('/pricing'),
    ];
    const { selected } = selectLeadPages({ home: HOME, homeLinks, sitemapUrls, cap: 8 });
    assert.deepEqual(
      selected.map((p) => `${p.reason}:${new URL(p.url).pathname}`),
      [
        'homepage:/',
        'navigation:/pricing',
        'navigation:/product',
        'template:/blog/latest-post', // the largest template, and the page the homepage links to
        'template:/customers/acme',
        'template:/about',
        'fill:/blog/post-0',
        'fill:/blog/post-1',
      ],
    );
    assert.equal(
      selected.some((p) => /login|privacy/.test(p.url)),
      false,
      'utility pages come last',
    );
  });

  void it('never exceeds the cap and never repeats a page', () => {
    const sitemapUrls = Array.from({ length: 500 }, (_, i) => u(`/section-${i % 40}/page-${i}`));
    const homeLinks: HomeLink[] = Array.from({ length: 30 }, (_, i) => ({
      url: u(`/menu-${i}`),
      position: 'header' as const,
    }));
    for (const cap of [1, 5, 25]) {
      const { selected } = selectLeadPages({ home: HOME, homeLinks, sitemapUrls: [HOME, ...sitemapUrls], cap });
      assert.equal(selected.length, cap);
      assert.equal(new Set(selected.map((p) => p.url.replace(/\/$/, ''))).size, cap);
      assert.equal(selected[0].url, HOME);
    }
    const nav = selectLeadPages({ home: HOME, homeLinks, sitemapUrls, cap: 25 }).selected.filter(
      (p) => p.reason === 'navigation',
    );
    assert.equal(nav.length, 10, 'the navigation gets at most 40% of the scan');
  });

  void it('honours robots.txt: a disallowed URL is never selected', () => {
    const { selected, disallowed } = selectLeadPages({
      home: HOME,
      homeLinks: [
        { url: u('/private/area'), position: 'header' },
        { url: u('/pricing'), position: 'header' },
      ],
      sitemapUrls: [u('/private/report'), u('/blog/a')],
      cap: 10,
      isAllowed: (path) => !path.startsWith('/private'),
    });
    assert.deepEqual(
      selected.map((p) => new URL(p.url).pathname),
      ['/', '/pricing', '/blog/a'],
    );
    assert.deepEqual(disallowed.map((d) => new URL(d).pathname).sort(), ['/private/area', '/private/report']);
  });

  void it('on a multi-language site samples templates once and adds the entry page of other languages', () => {
    const { selected, languages } = selectLeadPages({
      home: u('/en/'),
      homeLinks: [
        { url: u('/en/pricing'), position: 'header' },
        { url: u('/de/'), position: 'header' },
        { url: u('/fr/'), position: 'header' },
        { url: u('/es/'), position: 'header' },
      ],
      sitemapUrls: [u('/en/blog/a'), u('/de/blog/b'), u('/fr/blog/c'), u('/de/pricing'), u('/en/about')],
      cap: 10,
    });
    const paths = selected.map((p) => `${p.reason}:${new URL(p.url).pathname}`);
    assert.deepEqual(paths.slice(0, 6), [
      'homepage:/en/',
      'navigation:/en/pricing',
      'language:/de/',
      'language:/fr/',
      'template:/en/blog/a',
      'template:/en/about',
    ]);
    assert.deepEqual(languages, ['en', 'de', 'fr', 'es']);
    assert.equal(
      paths.filter((p) => p.startsWith('template:') && p.includes('/blog/')).length,
      1,
      'one blog page, not one per language',
    );
  });

  void it('leaves out other hosts, files and the homepage itself, and works with no homepage links', () => {
    const { selected } = selectLeadPages({
      home: HOME,
      homeLinks: [
        { url: 'https://other.example/x', position: 'header' },
        { url: u('/brochure.pdf'), position: 'header' },
        { url: 'https://www.example.com/', position: 'header' },
        { url: 'mailto:hi@example.com', position: 'header' },
      ],
      sitemapUrls: [u('/a'), u('/logo.png'), u('/b?utm=1')],
      cap: 10,
    });
    assert.deepEqual(
      selected.map((p) => new URL(p.url).pathname + new URL(p.url).search),
      ['/', '/a', '/b?utm=1'],
    );
    assert.deepEqual(selectLeadPages({ home: HOME, homeLinks: [], sitemapUrls: [], cap: 25 }).selected.length, 1);
  });

  void it('evenSample spreads over the list', () => {
    assert.deepEqual(evenSample([1, 2, 3], 5), [1, 2, 3]);
    assert.deepEqual(
      evenSample(
        Array.from({ length: 100 }, (_, i) => i),
        4,
      ),
      [0, 25, 50, 75],
    );
  });
});
