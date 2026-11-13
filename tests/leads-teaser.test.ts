import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LeadFile } from '../lib/leads/lead-file';
import {
  appendReviewRows,
  precisionByType,
  readReviewRows,
  readSuspended,
  resumeType,
  suspendType,
  type ReviewRow,
} from '../lib/leads/review-log';
import { buildReviewPage } from '../lib/leads/review-page';
import {
  DEFAULT_TEASER_CONFIG,
  DEFAULT_TEASER_CONFIG_PATH,
  TeaserError,
  buildTeaser,
  hasCausalWording,
  loadTeaserConfig,
  stackLine,
  whyItMatters,
} from '../lib/leads/teaser';
import type { Highlight } from '../lib/leads/truth-gate';

const h = (
  type: Highlight['type'],
  rootCause: string,
  fact: string,
  extra: Partial<Highlight['evidence']> = {},
  url = 'https://example.com/',
): Highlight => ({
  type,
  rootCause,
  angle: 'x',
  fact,
  url,
  evidence: {
    methods: ['http-get', 'browser-click'],
    control: { homepage: 200, randomMissing: 404 },
    checkedAt: '2026-11-20T10:19:04Z',
    ...extra,
  },
  gate: 'pass',
});

const HIGHLIGHTS: Highlight[] = [
  h(
    'end-of-life',
    'end-of-life:drupal',
    'The site runs on Drupal 7, which stopped receiving fixes on 2025-01-05',
    { value: 'Drupal 7', source: 'endoflife.date' },
    'https://endoflife.date/drupal',
  ),
  h('dead-nav-link', 'language-switch', 'The "عربي" link in the header returns 404 on all 23 pages scanned', {
    target: 'https://example.com/tools/locale?_lcl=ar_AE',
    status: 404,
    screenshot: 'evidence/dead-nav-link-5.png',
  }),
  h(
    'poor-vitals',
    'real-user-performance',
    'For real visitors on phones the main content takes 5.2 s to appear at the 75th percentile (Google rates anything above 4.0 s as poor)',
    {
      value: 5200,
      methods: ['chrome-ux-report'],
      source: 'Chrome UX Report, origin level, phones, 28 days to 2026-11-09',
    },
    'https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fexample.com&form_factor=mobile',
  ),
  h(
    'noindex',
    'noindex',
    '/pricing, linked from the main navigation, tells search engines not to index it (meta robots: noindex)',
    {},
    'https://example.com/pricing',
  ),
];

const lead = (overrides: Partial<LeadFile> = {}): LeadFile => ({
  domain: 'example.com',
  company: 'Example Ltd',
  runDir: '/tmp/run',
  runKind: 'lead',
  scannedAt: '2026-11-19T09:00:00Z',
  checkedAt: '2026-11-20T10:19:04Z',
  pagesScanned: 23,
  requestsSent: { scan: 1140, gate: 34 },
  stack: {
    kind: 'legacy',
    cms: 'Drupal',
    cmsSecondary: null,
    cmsVersion: '7',
    cmsVersionConfirmed: true,
    framework: null,
    frameworkVersion: null,
    libraries: [],
    eol: ['Drupal 7'],
    confidence: 'high',
    signals: ['meta:Drupal', 'header:Drupal'],
  },
  fitScore: 71,
  track: 'migrate',
  control: { homepage: 200, randomMissing: 404, blocked: false, statusUnreliable: false, note: null },
  highlights: HIGHLIGHTS,
  causes: HIGHLIGHTS.map((x) => x.rootCause),
  teaserReady: true,
  candidatesDropped: [
    { type: 'Orphan page', reason: 'not-on-allowlist', detail: 'orphan pages' },
    { type: 'broken-image', reason: 'second-method-disagrees', detail: 'x.jpg: plain GET saw 200' },
  ],
  disclosure: [],
  ...overrides,
});

void describe('teaser', () => {
  void it('shows three highlights with three different causes, the real page count and the evidence', () => {
    const teaser = buildTeaser(lead(), {
      ...DEFAULT_TEASER_CONFIG,
      calendarUrl: 'https://cal.example/fr',
      sender: 'Alex',
    });
    assert.equal(teaser.highlights.length, 3);
    assert.equal(new Set(teaser.highlights.map((x) => x.rootCause)).size, 3);
    assert.equal(teaser.subject, 'Example Ltd website: three things we noticed');
    const md = teaser.markdown;
    assert.match(md, /^# Example Ltd website: three things we noticed/);
    assert.match(md, /2026-11-20 · Based on 23 public pages of example\.com\. No login, no forms submitted\./);
    assert.match(md, /## 1\. The site runs on Drupal 7, which stopped receiving fixes on 2025-01-05\./);
    assert.match(md, /## 2\. The "عربي" link in the header returns 404 on all 23 pages scanned\./);
    assert.match(md, /\*\*The link goes to:\*\* <https:\/\/example\.com\/tools\/locale\?_lcl=ar_AE>/);
    assert.match(md, /!\[Screenshot: [^\]]+\]\(evidence\/dead-nav-link-5\.png\)/);
    assert.match(md, /\*\*Check it yourself:\*\* <https:\/\/pagespeed\.web\.dev/);
    assert.match(md, /\*\*What your site runs:\*\* Drupal 7/);
    assert.match(md, /walk you through it in 20 minutes: <https:\/\/cal\.example\/fr>/);
    assert.match(md, /Each point above was checked again on 2026-11-20\./);
    assert.equal(md.includes('noindex'), false, 'the fourth cause is not shown');
  });

  void it('has no score and no count of further issues', () => {
    const md = buildTeaser(lead()).markdown;
    assert.doesNotMatch(md, /\b\d+\s*\/\s*100\b|score of|\bgrade\b/i);
    assert.doesNotMatch(md, /\b\d+ (?:more|further|other|additional) (?:issues|problems|findings)/i);
  });

  void it('never claims a cause, in any template', () => {
    const teaser = buildTeaser(lead());
    assert.equal(hasCausalWording(teaser.markdown), false);
    assert.equal(hasCausalWording(teaser.email), false);
    for (const x of HIGHLIGHTS) assert.equal(hasCausalWording(whyItMatters(x)), false, x.rootCause);
    assert.equal(hasCausalWording('The switch is broken because of the CMS theme'), true);
    assert.equal(hasCausalWording('Slow pages are caused by large images'), true);
    assert.throws(
      () =>
        buildTeaser(
          lead({ highlights: [h('noindex', 'a', 'Pages are hidden due to the plugin'), ...HIGHLIGHTS.slice(0, 2)] }),
        ),
      (e: unknown) => e instanceof TeaserError && /claims a cause/.test(e.message),
    );
  });

  void it('the stack line is gated: high confidence only, a version only when two kinds agree', () => {
    assert.equal(stackLine(lead()), 'Drupal 7');
    const base = lead().stack!;
    assert.equal(stackLine(lead({ stack: { ...base, cmsVersionConfirmed: false } })), 'Drupal');
    assert.equal(stackLine(lead({ stack: { ...base, confidence: 'low' } })), null);
    assert.equal(stackLine(lead({ stack: null })), null);
    assert.equal(
      stackLine(
        lead({ stack: { ...base, kind: 'hybrid', cms: 'Concrete CMS', cmsVersion: null, cmsSecondary: 'Contentful' } }),
      ),
      'Concrete CMS and Contentful',
    );
    assert.equal(
      stackLine(
        lead({ stack: { ...base, kind: 'headless', cms: 'Contentful', cmsVersion: null, framework: 'Next.js' } }),
      ),
      'Contentful with a Next.js front end',
    );
    assert.equal(
      buildTeaser(lead({ stack: { ...base, confidence: 'low' } })).markdown.includes('What your site runs'),
      false,
    );
  });

  void it('is never padded and never built over a pending disclosure', () => {
    assert.throws(() => buildTeaser(lead({ highlights: HIGHLIGHTS.slice(0, 2), teaserReady: false })), /never padded/);
    assert.throws(
      () => buildTeaser(lead({ disclosure: [{ check: 'js-secrets', note: '1 finding' }] })),
      /disclose it first/,
    );
    // Two causes are allowed when the gate was run with a lower threshold and said so.
    const two = buildTeaser(lead({ highlights: HIGHLIGHTS.slice(0, 2), teaserReady: true }));
    assert.match(two.subject, /two things we noticed/);
  });

  void it('the email is three short paragraphs with an opt-out', () => {
    const email = buildTeaser(lead(), { ...DEFAULT_TEASER_CONFIG, calendarUrl: 'https://cal.example/fr' }).email;
    assert.match(email, /^Subject: Example Ltd website: three things we noticed\n/);
    assert.match(email, /We looked at 23 public pages of example\.com and noticed three things/);
    assert.match(
      email,
      /software past its end of life \(Drupal 7\), a language link that returns an error and real-user experience figures/,
    );
    assert.match(email, /reply "no thanks" and we will not write again/);
    assert.match(email, /https:\/\/cal\.example\/fr/);
  });

  void it('the shipped config file loads', () => {
    const config = loadTeaserConfig(DEFAULT_TEASER_CONFIG_PATH);
    assert.equal(config.agency, 'FocusReactive');
    assert.equal(config.callMinutes, 20);
    assert.ok(config.optOut.length > 10);
  });
});

void describe('review log and precision loop', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-review-'));
  const log = path.join(dir, 'review-log.csv');
  const suspended = path.join(dir, 'gate-suspended.json');
  const row = (type: string, verdict: ReviewRow['verdict'], factual = false): ReviewRow => ({
    reviewedAt: '2026-11-20T11:00:00Z',
    domain: 'example.com',
    highlight: 1,
    type,
    rootCause: type,
    verdict,
    factual,
    reason: verdict === 'reject' ? 'the link works, we were "blocked"' : '',
    fact: 'A fact, with a comma',
  });

  void it('records one row per highlight verdict and reads them back', () => {
    appendReviewRows([row('dead-nav-link', 'approve'), row('dead-nav-link', 'approve')], log);
    appendReviewRows([row('dead-nav-link', 'reject', true), row('noindex', 'approve')], log);
    const rows = readReviewRows(log);
    assert.equal(rows.length, 4);
    assert.equal(rows[2].reason, 'the link works, we were "blocked"');
    assert.equal(rows[2].factual, true);
    const precision = precisionByType(rows);
    assert.deepEqual(
      precision.find((p) => p.type === 'dead-nav-link'),
      { type: 'dead-nav-link', approved: 2, rejected: 1, factual: 1, rate: 2 / 3 },
    );
    assert.equal(precision.find((p) => p.type === 'noindex')?.rate, 1);
  });

  void it('a factual rejection suspends the type until it is resumed', () => {
    assert.deepEqual(readSuspended(suspended), {});
    suspendType('dead-nav-link', 'example.com', 'we were blocked', suspended);
    suspendType('dead-nav-link', 'other.example', 'again', suspended);
    assert.deepEqual(Object.keys(readSuspended(suspended)), ['dead-nav-link']);
    assert.equal(readSuspended(suspended)['dead-nav-link'].domain, 'example.com', 'the first rejection is kept');
    assert.equal(resumeType('dead-nav-link', suspended), true);
    assert.equal(resumeType('dead-nav-link', suspended), false);
    assert.deepEqual(readSuspended(suspended), {});
  });
});

void describe('review page', () => {
  void it('shows each highlight with its evidence, the dropped candidates and the commands', () => {
    const html = buildReviewPage([{ lead: lead(), stage: 'teaser_ready', disclosed: '' }], '/tmp');
    assert.match(html, /<h2>Example Ltd <small>example\.com<\/small><\/h2>/);
    assert.match(html, /1\. The site runs on Drupal 7/);
    assert.match(html, /Confirmed by<\/th><td>http-get \+ browser-click/);
    assert.match(html, /homepage 200, random missing URL 404/);
    assert.match(html, /<img src="run\/lead\/evidence\/dead-nav-link-5\.png"/);
    assert.match(html, /Checked and dropped \(1\)/);
    assert.match(html, /Audit findings left for the full audit \(1\)/);
    assert.match(html, /lead-pipeline\.ts approve example\.com/);
    assert.equal(html.includes('noindex, linked'), false);
  });

  void it('escapes what comes from a site and flags a pending disclosure', () => {
    const nasty = lead({ company: '<script>alert(1)</script>', disclosure: [{ check: 'js-secrets', note: 'x' }] });
    const html = buildReviewPage([{ lead: nasty, stage: 'teaser_ready', disclosed: 'pending' }], '/tmp');
    assert.equal(html.includes('<script>alert(1)</script>'), false);
    assert.match(html, /Disclose it first; no outreach until then/);
    assert.match(buildReviewPage([], '/tmp'), /No teaser is waiting for review/);
  });
});
