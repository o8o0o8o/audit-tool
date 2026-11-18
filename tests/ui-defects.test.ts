import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEAD_FRAGMENT_MESSAGE,
  DESKTOP_OVERFLOW_MESSAGE,
  DISTORTED_IMAGE_MESSAGE,
  DUPLICATE_ENTRY_MESSAGE,
  EMPTY_BLOCK_MESSAGE,
  LAYOUT_FINDING_MESSAGES,
  TEXT_OVERLAP_MESSAGE,
  evaluateDesktopLayout,
  evaluateLayout,
  findDuplicateEntries,
  findOverlappingLines,
  isDeadFragment,
  isDistortedImage,
  type LayoutSnapshot,
  type TextLine,
} from '../lib/analyzers/visual/layout-integrity-analyzer';
import {
  CLICK_ERROR_MESSAGE,
  CONTROL_DEAD_MESSAGE,
  INTERACTION_FINDING_MESSAGES,
  InteractionProbe,
  MAX_INTERACTION_PROBES,
  MAX_INTERACTION_PROBES_LEAD,
  MENU_DEAD_MESSAGE,
  UNSAFE_CONTROL,
  judgeClick,
  menuOpened,
  realErrors,
  responded,
  searchWord,
  type ClickOutcome,
  type ProbeTarget,
} from '../lib/analyzers/visual/interaction-probe';
import { categorize, isVisualFinding } from '../lib/phase2/categorize';
import { findingCheckGroups } from '../lib/presets';
import { ISSUE_CATALOG } from '../lib/scoring/seo-catalog';

const URL_ = 'https://example.com/page';
const line = (owner: number, x: number, y: number, width = 200, height = 20, text = `line ${owner}`): TextLine => ({
  owner,
  text,
  rect: { x, y, width, height },
});
const snapshot = (extra: Partial<LayoutSnapshot> = {}): LayoutSnapshot => ({
  viewport: { width: 414, height: 896 },
  scrollWidth: 414,
  overlaps: [],
  images: [],
  fragments: [],
  entries: [],
  emptyBlocks: [],
  ...extra,
});

void describe('layout defects', () => {
  void it('pairs text lines of different elements that are printed over each other', () => {
    const pairs = findOverlappingLines([
      line(1, 0, 0),
      line(2, 10, 4), // over line 1
      line(1, 0, 20), // second line of the same element: never a pair with its own first line
      line(3, 0, 100),
      line(4, 195, 100), // touches line 3 by 5px only
      line(5, 0, 118), // 2px of vertical contact with line 3
      line(6, 0, 300, 4, 4), // too small to be text a visitor reads
    ]);
    assert.deepEqual(
      pairs.map((p) => [p.a.owner, p.b.owner]),
      [[1, 2]],
    );
    assert.deepEqual(pairs[0]!.rect, { x: 10, y: 4, width: 190, height: 16 });
  });

  void it('reports one pair per two elements and stops at the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => line(i, 0, 0));
    assert.equal(findOverlappingLines(many, 5).length, 5);
    const twice = findOverlappingLines([line(1, 0, 0), line(2, 0, 2), line(1, 0, 10), line(2, 0, 12)]);
    assert.equal(twice.filter((p) => p.a.owner + p.b.owner === 3).length, 1);
  });

  void it('calls an image distorted only when nothing crops it and the ratio is clearly off', () => {
    const img = (width: number, height: number, objectFit = 'fill', naturalWidth = 100, naturalHeight = 100) => ({
      src: 'https://example.com/a.jpg',
      naturalWidth,
      naturalHeight,
      width,
      height,
      objectFit,
    });
    assert.equal(isDistortedImage(img(300, 100)), true);
    assert.equal(isDistortedImage(img(300, 100, 'cover')), false, 'cropped, not stretched');
    assert.equal(isDistortedImage(img(105, 100)), false, 'within tolerance');
    assert.equal(isDistortedImage(img(40, 12)), false, 'an icon');
    assert.equal(isDistortedImage(img(300, 100, 'fill', 0, 0)), false, 'not loaded');
  });

  void it('calls an in-page link dead only when it names a section and nothing scripted handles it', () => {
    const l = (fragment: string, targetExists = false, scripted = false) => ({
      fragment,
      text: 'x',
      targetExists,
      scripted,
    });
    assert.equal(isDeadFragment(l('pricing')), true);
    assert.equal(isDeadFragment(l('pricing', true)), false);
    assert.equal(isDeadFragment(l('pricing', false, true)), false, 'a tab or a modal trigger');
    for (const f of ['', 'top', '!/route', '/app/page', 'tab=2']) assert.equal(isDeadFragment(l(f)), false, f);
  });

  void it('finds the same entry twice in one list, not across lists or looks, and not for bare numbers', () => {
    const e = (list: number, text: string, href = '', group = 'DIV.item') => ({ list, text, href, group });
    const found = findDuplicateEntries([
      e(1, 'Germany', '/de'),
      e(1, 'Norway', '/no'),
      e(1, ' germany ', '/de'),
      e(2, 'Germany', '/de'), // another list
      e(1, 'Germany', '/de', 'H3.title'), // another look
      e(1, 'Read more', '/a'),
      e(1, 'Read more', '/b'), // same words, another destination
      e(1, 'France', '/fr'),
      e(3, '€ 49', '/p'),
      e(3, '€ 49', '/p'),
      e(4, 'Self-paced'), // a label on two cards, leading nowhere
      e(4, 'Self-paced'),
      e(4, 'Introductory'),
      e(4, 'Advanced'),
      e(5, 'Rent a car', '/rent'), // a list that is mostly one entry repeats it on purpose
      e(5, 'Rent a car', '/rent'),
      e(5, 'Rent a car', '/rent'),
    ]);
    assert.deepEqual(
      found.map((d) => [d.entry.text.trim().toLowerCase(), d.times]),
      [['germany', 2]],
    );
  });

  void it('turns a snapshot into findings with highlight boxes', () => {
    const a = line(1, 0, 0, 200, 20, 'First paragraph');
    const b = line(2, 0, 4, 200, 20, 'Second paragraph');
    const data = evaluateLayout(
      snapshot({
        overlaps: [{ a, b, rect: { x: 0, y: 4, width: 200, height: 16 } }],
        images: [
          {
            src: 'https://example.com/img/team.jpg?w=1',
            naturalWidth: 100,
            naturalHeight: 100,
            width: 300,
            height: 100,
            objectFit: 'fill',
            rect: { x: 0, y: 50, width: 300, height: 100 },
          },
        ],
        fragments: [{ fragment: 'pricing', text: 'Pricing', targetExists: false, scripted: false }],
        entries: [
          { list: 1, text: 'Germany', href: '/de', rect: { x: 0, y: 300, width: 100, height: 20 } },
          { list: 1, text: 'Germany', href: '/de' },
          { list: 1, text: 'France', href: '/fr' },
          { list: 1, text: 'Norway', href: '/no' },
        ],
        emptyBlocks: [{ tag: 'section', rect: { x: 0, y: 900, width: 414, height: 500 } }],
      }),
      URL_,
    );
    assert.deepEqual(
      data.issues.map((i) => i.message),
      [
        TEXT_OVERLAP_MESSAGE,
        DISTORTED_IMAGE_MESSAGE,
        DEAD_FRAGMENT_MESSAGE,
        DUPLICATE_ENTRY_MESSAGE,
        EMPTY_BLOCK_MESSAGE,
      ],
    );
    assert.match(data.issues[0]!.detail ?? '', /"First paragraph \/ Second paragraph"/);
    assert.match(data.issues[1]!.detail ?? '', /team\.jpg\?w=1 \(file 100×100, shown 300×100\)/);
    assert.deepEqual(data.deadFragments, ['#pricing']);
    assert.deepEqual(data.duplicateEntries, ['Germany ×2']);
    assert.equal(data.highlights?.length, 4, 'one box per located defect');
    assert.equal(evaluateLayout(snapshot(), URL_).issues.length, 0);
  });

  void it('the desktop pass reports overlap and sideways scroll only', () => {
    const wide = snapshot({
      viewport: { width: 1366, height: 800 },
      scrollWidth: 1700,
      fragments: [{ fragment: 'pricing', text: 'Pricing', targetExists: false, scripted: false }],
      overlaps: [{ a: line(1, 0, 0), b: line(2, 0, 2), rect: { x: 0, y: 2, width: 200, height: 18 } }],
    });
    const issues = evaluateDesktopLayout(wide, URL_);
    assert.deepEqual(
      issues.map((i) => i.message),
      [TEXT_OVERLAP_MESSAGE, DESKTOP_OVERFLOW_MESSAGE],
    );
    assert.match(issues[0]!.detail ?? '', /at 1366px wide \(desktop\)/);
    assert.match(issues[1]!.detail ?? '', /334px wider than a 1366px desktop window/);
    assert.equal(
      evaluateDesktopLayout(snapshot({ viewport: { width: 1366, height: 800 }, scrollWidth: 1374 }), URL_).length,
      0,
    );
  });
});

void describe('click probes', () => {
  const nothing: ClickOutcome = {
    clicked: true,
    stateBefore: 'false|||||',
    stateAfter: 'false|||||',
    mutations: 0,
    linksBefore: 4,
    linksAfter: 4,
    urlChanged: false,
    requests: 0,
    sideEffects: 0,
    errors: [],
  };
  const target = (kind: ProbeTarget['kind'], name = '"Show more"'): ProbeTarget => ({ id: 1, kind, name });

  void it('counts any change on the page as a response', () => {
    assert.equal(responded(nothing), false);
    for (const change of [
      { stateAfter: 'true|||||' },
      { mutations: 3 },
      { urlChanged: true },
      { requests: 1 },
      { sideEffects: 1 },
    ]) {
      assert.equal(responded({ ...nothing, ...change }), true, JSON.stringify(change));
    }
    assert.equal(menuOpened({ ...nothing, linksAfter: 12 }), true);
    assert.equal(menuOpened({ ...nothing, linksAfter: 5 }), false);
  });

  void it('reports a dead menu button and a dead control, and nothing for one that was covered', () => {
    assert.deepEqual(
      judgeClick(target('menu', 'the menu button ("Menu")'), nothing, URL_).map((i) => [i.message, i.severity]),
      [[MENU_DEAD_MESSAGE, 'high']],
    );
    assert.deepEqual(
      judgeClick(target('button'), nothing, URL_).map((i) => [i.message, i.severity]),
      [[CONTROL_DEAD_MESSAGE, 'medium']],
    );
    assert.equal(judgeClick(target('button'), { ...nothing, clicked: false }, URL_).length, 0);
    assert.equal(judgeClick(target('disclosure'), { ...nothing, stateAfter: 'true|||||' }, URL_).length, 0);
    assert.equal(judgeClick(target('menu'), { ...nothing, mutations: 2 }, URL_).length, 0, 'the page reacted');
  });

  void it('reports an error thrown by a click once, without a second "no response" finding', () => {
    const issues = judgeClick(
      target('button', '"Compare models"'),
      { ...nothing, errors: ["Cannot read properties of undefined (reading 'open')\n    at HTMLButtonElement"] },
      URL_,
    );
    assert.deepEqual(
      issues.map((i) => i.message),
      [CLICK_ERROR_MESSAGE],
    );
    assert.match(
      issues[0]!.detail ?? '',
      /clicking "Compare models" throws "Cannot read properties of undefined \(reading 'open'\)"/,
    );
  });

  void it('ignores the browser`s generic error messages', () => {
    assert.deepEqual(
      realErrors([
        'Script error.',
        'ResizeObserver loop limit exceeded',
        'Failed to fetch',
        'x is not a function',
        'x is not a function',
      ]),
      ['x is not a function'],
    );
  });

  void it('never clicks controls that buy, send, sign in, remove or answer a consent prompt', () => {
    for (const label of [
      'Add to cart',
      'Buy now',
      'Checkout',
      'Subscribe',
      'Log in',
      'Sign up',
      'Delete',
      'Accept all',
      'Reject',
      'Book a demo',
      'In den Warenkorb',
      'Send',
    ]) {
      assert.equal(UNSAFE_CONTROL.test(label), true, label);
    }
    for (const label of ['Show more', 'Next', 'Read the full story', 'Open filters', 'Compare models']) {
      assert.equal(UNSAFE_CONTROL.test(label), false, label);
    }
  });

  void it('picks a word from the page to search for', () => {
    assert.equal(searchWord(['Home', 'Products', 'About', 'Sustainability report']), 'sustainability');
    assert.equal(searchWord(['Home', 'Menu', 'FAQ']), null);
  });

  void it('probes one page per URL template and stops at the audit`s budget', () => {
    InteractionProbe.resetProbeState();
    assert.equal(InteractionProbe.shouldProbe('https://example.com/'), true);
    assert.equal(
      InteractionProbe.shouldProbe('https://example.com/en/'),
      false,
      'the homepage again, in a language folder',
    );
    assert.equal(InteractionProbe.shouldProbe('https://example.com/blog/a'), true);
    assert.equal(InteractionProbe.shouldProbe('https://example.com/blog/b'), false);
    for (let i = 0; i < 20; i++) InteractionProbe.shouldProbe(`https://example.com/t${i}/x`);
    assert.equal(InteractionProbe.shouldProbe('https://example.com/one-more/x'), false);
    InteractionProbe.resetProbeState();
    let lead = 0;
    for (let i = 0; i < 20; i++) lead += Number(InteractionProbe.shouldProbe(`https://example.com/t${i}/x`, true));
    assert.equal(lead, MAX_INTERACTION_PROBES_LEAD);
    assert.ok(MAX_INTERACTION_PROBES > MAX_INTERACTION_PROBES_LEAD);
    InteractionProbe.resetProbeState();
  });
});

void describe('reporting of the new findings', () => {
  void it('every message is a visual finding with a catalog entry, routed to the UX section', () => {
    for (const message of [...LAYOUT_FINDING_MESSAGES, ...INTERACTION_FINDING_MESSAGES]) {
      assert.equal(isVisualFinding(message), true, message);
      assert.equal(categorize(message), 'ux', message);
      assert.ok(ISSUE_CATALOG[message], `catalog: ${message}`);
      assert.ok(findingCheckGroups(message, 'ux').includes('visual'), `visual check group: ${message}`);
    }
  });
});
