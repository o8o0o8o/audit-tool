import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  BrokenMediaAnalyzer,
  classifyBrokenImages,
  classifyFailedMediaRequests,
} from '../lib/analyzers/visual/broken-media-analyzer';
import { ISSUE_CATALOG } from '../lib/scoring/seo-catalog';
import { EXTENDED_FIX_RECOMMENDATIONS } from '../lib/scoring/fix-recommendations-extended';
import type { ChromePage } from '../lib/types';

const img = (over: Partial<Parameters<typeof classifyBrokenImages>[0][number]> = {}) => ({
  src: 'https://x.test/a.png',
  complete: true,
  naturalWidth: 100,
  displayWidth: 100,
  displayHeight: 100,
  ...over,
});

void describe('broken media', () => {
  void it('flags a complete image that decoded to zero width', () => {
    assert.deepStrictEqual(classifyBrokenImages([img({ naturalWidth: 0 }), img({ src: 'https://x.test/ok.png' })]), [
      'https://x.test/a.png',
    ]);
  });

  void it('ignores healthy, not-yet-loaded lazy images and tracking pixels', () => {
    assert.deepStrictEqual(
      classifyBrokenImages([
        img(),
        img({ complete: false, naturalWidth: 0, loading: 'lazy' }),
        img({ naturalWidth: 0, displayWidth: 1, displayHeight: 1 }),
      ]),
      [],
    );
  });

  void it('flags 4xx/5xx image and media requests only', () => {
    const failed = classifyFailedMediaRequests({
      'https://x.test/a.png': { resourceType: 'image', status: 404 },
      'https://x.test/v.mp4': { resourceType: 'media', status: 503 },
      'https://x.test/ok.png': { resourceType: 'image', status: 200 },
      'https://x.test/app.js': { resourceType: 'script', status: 404 },
      'https://x.test/f.woff2': { resourceType: 'font', status: 500 },
      'https://x.test/pending.png': { resourceType: 'image' },
    });
    assert.deepStrictEqual(
      failed.map((f) => f.url),
      ['https://x.test/a.png', 'https://x.test/v.mp4'],
    );
  });

  void it('drops failed requests already reported as broken images', () => {
    const failed = classifyFailedMediaRequests(
      { 'https://x.test/a.png': { resourceType: 'image', status: 404 } },
      ['https://x.test/a.png'],
    );
    assert.strictEqual(failed.length, 0);
  });

  void it('analyze emits each finding once with the right severity', async () => {
    const page = {
      evaluate: async () => ({
        imgs: [img({ naturalWidth: 0 })],
        media: [{ src: 'https://x.test/v.mp4', tag: 'video', noSource: true }],
      }),
    } as unknown as ChromePage;
    const res = await BrokenMediaAnalyzer.analyze(page, 'https://x.test/', {
      'https://x.test/a.png': { resourceType: 'image', status: 404 },
      'https://x.test/v.mp4': { resourceType: 'media', status: 404 },
    });
    assert.deepStrictEqual(
      res.issues.map((i) => [i.severity, i.message]),
      [
        ['high', 'Broken images detected'],
        ['medium', 'Failed image or media requests'],
      ],
    );
    assert.match(res.issues[1]!.detail!, /1 image\/media/);
  });
});

void describe('upscaled', async () => {
  const { classifyUpscaledImage, classifyBackgroundUpscale } = await import(
    '../lib/analyzers/performance/image-optimization-analyzer'
  );
  const up = (over: Partial<Parameters<typeof classifyUpscaledImage>[0]> = {}) => ({
    src: 'https://x.test/a.png',
    srcset: '',
    naturalWidth: 100,
    displayWidth: 300,
    ...over,
  });
  const bg = (over: Partial<Parameters<typeof classifyBackgroundUpscale>[0]> = {}) => ({
    url: 'https://x.test/bg.jpg',
    naturalWidth: 200,
    naturalHeight: 100,
    elementWidth: 400,
    elementHeight: 200,
    backgroundSize: 'cover',
    backgroundRepeat: 'no-repeat',
    ...over,
  });

  void it('flags a no-srcset img drawn below display × DPR', () => {
    assert.strictEqual(classifyUpscaledImage(up(), 1), true);
    assert.strictEqual(classifyUpscaledImage(up({ naturalWidth: 300, displayWidth: 300 }), 2), true);
  });

  void it('skips svg, data:, srcset and adequately sized images', () => {
    assert.strictEqual(classifyUpscaledImage(up({ src: 'https://x.test/a.svg?v=1' }), 1), false);
    assert.strictEqual(classifyUpscaledImage(up({ src: 'data:image/png;base64,AAAA' }), 1), false);
    assert.strictEqual(classifyUpscaledImage(up({ srcset: 'a.png 1x, b.png 2x' }), 1), false);
    assert.strictEqual(classifyUpscaledImage(up({ naturalWidth: 600 }), 2), false);
    assert.strictEqual(classifyUpscaledImage(up({ naturalWidth: 0 }), 1), false);
  });

  void it('flags a cover/stretched CSS background below element × DPR', () => {
    assert.strictEqual(classifyBackgroundUpscale(bg(), 1), true);
    assert.strictEqual(classifyBackgroundUpscale(bg({ backgroundSize: '100% 100%' }), 1), true);
    assert.strictEqual(classifyBackgroundUpscale(bg({ backgroundSize: '400px auto' }), 1), true);
  });

  void it('skips repeat patterns, svg, natural-size and adequate backgrounds', () => {
    assert.strictEqual(classifyBackgroundUpscale(bg({ backgroundRepeat: 'repeat' }), 1), false);
    assert.strictEqual(classifyBackgroundUpscale(bg({ url: 'https://x.test/p.svg' }), 1), false);
    assert.strictEqual(classifyBackgroundUpscale(bg({ backgroundSize: 'auto' }), 1), false);
    assert.strictEqual(classifyBackgroundUpscale(bg({ naturalWidth: 800, naturalHeight: 400 }), 2), false);
    assert.strictEqual(classifyBackgroundUpscale(bg({ backgroundSize: 'contain', elementHeight: 400 }), 1), true);
    assert.strictEqual(classifyBackgroundUpscale(bg({ naturalWidth: 400, naturalHeight: 200, backgroundSize: 'contain' }), 1), false);
  });
});

void describe('text integrity', async () => {
  const { findTemplateTokens, hasPlaceholderText, findMojibake, isClippedText, TextIntegrityAnalyzer } = await import(
    '../lib/analyzers/visual/text-integrity-analyzer'
  );
  const clip = (over: Partial<Parameters<typeof isClippedText>[0]> = {}) => ({
    overflowX: 'hidden',
    overflowY: 'visible',
    textOverflow: 'clip',
    lineClamp: 'none',
    scrollWidth: 300,
    clientWidth: 200,
    scrollHeight: 20,
    clientHeight: 20,
    ...over,
  });

  void it('flags template tokens, bare and value-slot undefined/NaN', () => {
    assert.deepStrictEqual(findTemplateTokens('Hello {{ user.name }}'), ['{{ user.name }}']);
    assert.deepStrictEqual(findTemplateTokens('[object Object]'), ['[object Object]']);
    assert.deepStrictEqual(findTemplateTokens(' undefined '), ['undefined']);
    assert.deepStrictEqual(findTemplateTokens('Price: $NaN'), ['NaN']);
    assert.deepStrictEqual(findTemplateTokens('Discount NaN%'), ['NaN']);
    assert.deepStrictEqual(findTemplateTokens('Name: undefined'), ['undefined']);
  });

  void it('passes normal text and prose mentions', () => {
    assert.deepStrictEqual(findTemplateTokens('The function returns undefined when empty.'), []);
    assert.deepStrictEqual(findTemplateTokens('NaN is not a number'), []);
    assert.deepStrictEqual(findTemplateTokens('Welcome to our store'), []);
  });

  void it('flags lorem ipsum placeholder text', () => {
    assert.strictEqual(hasPlaceholderText('Lorem ipsum dolor sit amet'), true);
    assert.strictEqual(hasPlaceholderText('Real product copy'), false);
  });

  void it('flags mojibake pairs and repeated replacement chars, not real accents', () => {
    assert.deepStrictEqual(findMojibake('CafÃ© menu'), ['Ã©']);
    assert.deepStrictEqual(findMojibake('itâ€™s'), ['â€']);
    assert.deepStrictEqual(findMojibake('a�b�c�'), ['�']);
    assert.deepStrictEqual(findMojibake('São Paulo, MÃE, Café, one �'), []);
  });

  void it('flags clipped text and passes ellipsis/line-clamp truncation', () => {
    assert.strictEqual(isClippedText(clip()), true);
    assert.strictEqual(isClippedText(clip({ overflowX: 'visible', overflowY: 'hidden', scrollHeight: 80 })), true);
    assert.strictEqual(isClippedText(clip({ textOverflow: 'ellipsis' })), false);
    assert.strictEqual(isClippedText(clip({ lineClamp: '2' })), false);
    assert.strictEqual(isClippedText(clip({ scrollWidth: 204 })), false);
    assert.strictEqual(isClippedText(clip({ overflowX: 'visible' })), false);
  });

  void it('isClippedText ignores visually-hidden (.sr-only) screen-reader text', () => {
    const srOnly = { overflowY: 'hidden', clientWidth: 1, clientHeight: 1, scrollWidth: 70, scrollHeight: 20 };
    assert.strictEqual(isClippedText(clip({ ...srOnly, clip: 'rect(0px, 0px, 0px, 0px)' })), false);
    assert.strictEqual(isClippedText(clip({ ...srOnly, clip: 'auto', clipPath: 'inset(50%)' })), false);
    assert.strictEqual(isClippedText(clip({ ...srOnly, clip: 'auto', clipPath: 'none' })), false);
    assert.strictEqual(isClippedText(clip({ clip: 'auto', clipPath: 'none' })), true);
  });

  void it('analyze emits each finding with the right severity', async () => {
    const page = {
      evaluate: async () => ({
        texts: [{ value: 'Hello {{ name }}' }, { value: 'Lorem ipsum dolor' }, { value: 'CafÃ©' }],
        clipped: [{ tag: 'p', text: 'Long text', metrics: clip() }],
      }),
    } as unknown as ChromePage;
    const res = await TextIntegrityAnalyzer.analyze(page, 'https://x.test/');
    assert.deepStrictEqual(
      res.issues.map((i) => [i.severity, i.message]),
      [
        ['high', 'Unrendered template tokens in page text'],
        ['medium', 'Placeholder text (lorem ipsum) on page'],
        ['medium', 'Garbled characters (mojibake) in page text'],
        ['low', 'Text clipped by its container'],
      ],
    );
  });
});

void describe('visual catalog', () => {
  void it('has a catalog entry and fix recommendation for every visual message', () => {
    for (const m of [
      'Broken images detected',
      'Failed image or media requests',
      'Images upscaled beyond natural resolution',
      'CSS background images upscaled beyond natural resolution',
      'Unrendered template tokens in page text',
      'Placeholder text (lorem ipsum) on page',
      'Garbled characters (mojibake) in page text',
      'Text clipped by its container',
    ]) {
      assert.ok(ISSUE_CATALOG[m], `catalog: ${m}`);
      assert.ok(EXTENDED_FIX_RECOMMENDATIONS[m]?.fix, `fix: ${m}`);
    }
  });
});
