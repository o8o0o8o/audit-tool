import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMediaHighlights } from '../lib/analyzers/visual/broken-media-analyzer';
import { buildTextHighlights } from '../lib/analyzers/visual/text-integrity-analyzer';
import { planBands } from '../lib/crawler/visual-shot-capture';
import { generateHTML } from '../generateHTML';

const PAGE = 'https://site.test/about';
const rect = (y: number, height = 40) => ({ x: 10, y, width: 100, height });

describe('visual highlights', () => {
  it('boxes broken images, failed requests and source-less media', () => {
    const imgs = [
      { src: 'https://site.test/a.png', complete: true, naturalWidth: 0, displayWidth: 100, displayHeight: 40, rect: rect(100) },
      { src: 'https://site.test/b.png', complete: true, naturalWidth: 0, displayWidth: 100, displayHeight: 40, rect: rect(300) },
      { src: 'https://site.test/ok.png', complete: true, naturalWidth: 50, displayWidth: 100, displayHeight: 40, rect: rect(500) },
    ];
    const media = [{ src: 'https://site.test/v.mp4', tag: 'video' as const, noSource: true, rect: rect(700) }];
    const out = buildMediaHighlights(
      imgs,
      media,
      ['https://site.test/a.png'],
      [{ url: 'https://site.test/b.png', status: 404, resourceType: 'image' }],
      ['https://site.test/v.mp4'],
    );
    assert.deepStrictEqual(
      out.map((h) => [h.kind, h.rect.y, h.label]),
      [
        ['Broken images detected', 100, 'broken image'],
        ['Failed image or media requests', 300, 'HTTP 404'],
        ['Failed image or media requests', 700, 'video failed to load'],
      ],
    );
  });

  it('boxes only the text nodes holding the defect', () => {
    const out = buildTextHighlights(
      [
        { value: 'Price: {{ price }}', rect: rect(100) },
        { value: 'Clean copy', rect: rect(200) },
        { value: 'Lorem ipsum dolor', rect: rect(300) },
        { value: 'CafÃ©', rect: rect(400) },
      ],
      ['Ã©'],
      [],
    );
    assert.deepStrictEqual(
      out.map((h) => [h.kind, h.rect.y]),
      [
        ['Unrendered template tokens in page text', 100],
        ['Placeholder text (lorem ipsum) on page', 300],
        ['Garbled characters (mojibake) in page text', 400],
      ],
    );
  });
});

describe('planBands', () => {
  const h = (kind: string, y: number) => ({ kind, rect: rect(y), label: kind });

  it('merges nearby defects of one kind into a band and splits distant ones', () => {
    const bands = planBands([h('A', 100), h('A', 300), h('A', 3000), h('B', 120)], 5000);
    assert.deepStrictEqual(
      bands.map((b) => [b.kind, b.y, b.items.length]),
      [
        ['A', 0, 2],
        ['B', 0, 1],
        ['A', 2840, 1],
      ],
    );
    for (const b of bands) assert.ok(b.height <= 900);
  });

  it('respects the per-page band cap', () => {
    const bands = planBands([h('A', 0), h('A', 2000), h('A', 4000)], 6000, 2);
    assert.strictEqual(bands.length, 2);
  });
});

function renderHtml(page: Record<string, unknown>, visual: boolean, withShotFile = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-ui-'));
  const auditFile = path.join(dir, 'audit.json');
  if (withShotFile) {
    fs.mkdirSync(path.join(dir, 'evidence', 'p--visual'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'evidence', 'p--visual', 'shot-1.jpg'), Buffer.from('JPEGDATA'));
  }
  fs.writeFileSync(
    auditFile,
    JSON.stringify({
      robots: { sitemaps: [], 'user-agent': {} },
      sitemaps: { urls: {}, total: 1 },
      isMultiLang: false,
      timing: {},
      pageData: {
        pages: { [PAGE]: { url: PAGE, status: 200, ...page } },
        processedPages: [PAGE],
        totalWithoutError: 1,
        totalWithError: 0,
        byError: {},
      },
      analysis: { overall: [], details: {}, bySeverity: {}, summary: {} },
    }),
  );
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ visual }));
  const out = path.join(dir, 'site.test.html');
  generateHTML(auditFile, 'site.test', out);
  return fs.readFileSync(out, 'utf8');
}

const brokenPage = {
  brokenMediaData: {
    brokenImages: ['https://site.test/a.png'],
    brokenMedia: [],
    failedRequests: [],
    issues: [{ severity: 'high', message: 'Broken images detected', detail: `<a href="${PAGE}">${PAGE}</a> has 1 image(s) that failed to render: https://site.test/a.png` }],
  },
  visualShots: [
    {
      kind: 'Broken images detected',
      file: 'evidence/p--visual/shot-1.jpg',
      width: 400,
      height: 200,
      boxes: [{ rect: { x: 100, y: 50, width: 200, height: 100 }, label: 'broken image' }],
    },
  ],
};

describe('HTML UI Issues section', () => {
  it('renders each finding with the inlined screenshot and a positioned highlight box', () => {
    const html = renderHtml(brokenPage, true);
    assert.match(html, /id="ui-issues"/);
    assert.match(html, /UI Issues \(1\)/);
    assert.match(html, /href="#ui-issues"/);
    assert.ok(html.includes(`data:image/jpeg;base64,${Buffer.from('JPEGDATA').toString('base64')}`));
    assert.match(html, /class="ui-shot-box" style="left:25\.00%;top:25\.00%;width:50\.00%;height:50\.00%;"/);
    assert.match(html, /broken image/);
  });

  it('lists a finding without a screenshot when the file is missing', () => {
    const html = renderHtml(brokenPage, true, false);
    assert.match(html, /UI Issues \(1\)/);
    assert.match(html, /No screenshot/);
  });

  it('shows the clean note when the check ran and found nothing', () => {
    const html = renderHtml({}, true);
    assert.match(html, /UI Issues \(0\)/);
    assert.match(html, /No UI issues found/);
  });

  it('omits the section, nav link and tab when the check did not run', () => {
    const html = renderHtml(brokenPage, false);
    assert.doesNotMatch(html, /id="ui-issues"/);
    assert.doesNotMatch(html, /#ui-issues|data-target="ui-issues"/);
  });
});
