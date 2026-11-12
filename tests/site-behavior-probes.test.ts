import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BotParityProbe,
  GOOGLEBOT_SMARTPHONE_UA,
  fetchWithChain,
  isChallengePage,
  type RawFetcher,
  type RawResponse,
} from '../lib/analyzers/site-checks/bot-parity-probe';
import { LocaleRedirectProbe } from '../lib/analyzers/site-checks/locale-redirect-probe';
import {
  ConsentRejectTest,
  consentRejectVerdict,
  trackerVendor,
  type ConsentBrowser,
  type ConsentFrame,
  type ConsentLocator,
  type ConsentPage,
  type ConsentRequest,
} from '../lib/analyzers/site-checks/consent-reject-test';
import {
  SessionReplaySensitive,
  detectReplayVendors,
  extractSensitiveFields,
} from '../lib/analyzers/site-checks/session-replay-sensitive';
import { SEVERITY } from '../lib/constants';

const html = (title: string, extra = '') =>
  `<html><head><title>${title}</title><link rel="canonical" href="https://ex.com/"><meta name="robots" content="index,follow">${extra}</head></html>`;

const uaFetcher =
  (pick: (ua: string, url: string) => RawResponse | null): RawFetcher =>
  async (url, headers) =>
    pick(headers['User-Agent'], url);

// ─── bot parity ─────────────────────────────────────────────────────────────

void test('fetchWithChain follows redirects and records the chain', async () => {
  const f: RawFetcher = async (url) =>
    url === 'https://ex.com/a' ? { status: 301, location: '/b' } : { status: 200, body: html('B') };
  const o = await fetchWithChain('https://ex.com/a', {}, f);
  assert.equal(o?.finalUrl, 'https://ex.com/b');
  assert.equal(o?.chain.length, 2);
  assert.equal(o?.title, 'B');
});

void test('bot parity: different SEO tags for Googlebot is HIGH', async () => {
  const f = uaFetcher((ua) => ({ status: 200, body: html(ua === GOOGLEBOT_SMARTPHONE_UA ? 'Bot' : 'Human') }));
  const r = await BotParityProbe.probe('https://ex.com', { fetcher: f });
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].message, 'Googlebot is served different SEO tags than browsers');
  assert.equal(r.issues[0].severity, SEVERITY.HIGH);
});

void test('bot parity: identical responses pass', async () => {
  const f = uaFetcher(() => ({ status: 200, body: html('Same') }));
  const r = await BotParityProbe.probe('https://ex.com', { fetcher: f, robotsAllows: () => true });
  assert.equal(r.issues.length, 0);
  assert.deepEqual(
    r.checks.map((c) => c.status),
    ['pass', 'pass'],
  );
});

void test('bot parity: blocked Googlebot is LOW, blocked allowed AI bot is MEDIUM', async () => {
  const f = uaFetcher((ua) => {
    if (ua === GOOGLEBOT_SMARTPHONE_UA) return { status: 403, body: '' };
    if (ua.includes('GPTBot')) return { status: 200, body: '<title>Just a moment...</title>' };
    if (ua.includes('ClaudeBot')) return { status: 429, body: '' };
    return { status: 200, body: html('Ok') };
  });
  // ClaudeBot disallowed by robots → its block is intended
  const r = await BotParityProbe.probe('https://ex.com', { fetcher: f, robotsAllows: (ua) => ua !== 'ClaudeBot' });
  const gb = r.issues.find((i) => i.message === 'Requests with a Googlebot user agent are blocked');
  assert.equal(gb?.severity, SEVERITY.LOW);
  const ai = r.issues.find((i) => i.message === 'AI crawlers blocked by firewall despite robots.txt allowing them');
  assert.equal(ai?.severity, SEVERITY.MEDIUM);
  assert.match(ai!.detail!, /GPTBot/);
  assert.doesNotMatch(ai!.detail!, /ClaudeBot/);
});

void test('bot parity: network failures give no findings', async () => {
  const r = await BotParityProbe.probe('https://ex.com', { fetcher: async () => null, robotsAllows: () => true });
  assert.equal(r.issues.length, 0);
  assert.equal(r.checks[0].status, 'skipped');
  assert.ok(isChallengePage('<script src="/cdn-cgi/challenge-platform/x"></script>'));
});

// ─── locale redirect ────────────────────────────────────────────────────────

void test('locale redirect: target depends on Accept-Language', async () => {
  const f: RawFetcher = async (_url, h) => {
    const lang = h['Accept-Language']?.slice(0, 2);
    return lang && lang !== 'en' ? { status: 302, location: `/${lang}/` } : { status: 302, location: '/en/' };
  };
  const r = await LocaleRedirectProbe.probe('https://ex.com', f);
  assert.equal(r.issues[0].message, 'Homepage redirects by browser language');
  assert.equal(r.issues[0].severity, SEVERITY.MEDIUM);
});

void test('locale redirect: only no-Accept-Language redirects is still reported', async () => {
  const f: RawFetcher = async (_url, h) =>
    h['Accept-Language'] ? { status: 200 } : { status: 302, location: '/en-us/' };
  const r = await LocaleRedirectProbe.probe('https://ex.com', f);
  assert.equal(r.issues.length, 1);
});

void test('locale redirect: same response passes; failures skip', async () => {
  assert.equal((await LocaleRedirectProbe.probe('https://ex.com', async () => ({ status: 200 }))).issues.length, 0);
  const s = await LocaleRedirectProbe.probe('https://ex.com', async () => null);
  assert.equal(s.checks[0].status, 'skipped');
});

// ─── consent reject ─────────────────────────────────────────────────────────

void test('trackerVendor ignores Consent Mode denied pings', () => {
  assert.equal(trackerVendor('https://www.google-analytics.com/g/collect?v=2&gcs=G100'), null);
  assert.equal(trackerVendor('https://region1.google-analytics.com/g/collect?v=2&gcs=G111'), 'Google Analytics');
  assert.equal(trackerVendor('https://www.facebook.com/tr?id=1'), 'Meta Pixel');
  assert.equal(trackerVendor('https://example.com/app.js'), null);
});

void test('consentRejectVerdict: cookies alone trigger HIGH', () => {
  const i = consentRejectVerdict({ requests: [], cookies: [{ name: '_ga', domain: '.ex.com' }] }, 'OneTrust');
  assert.equal(i?.message, 'Trackers still run after consent is rejected');
  assert.equal(i?.severity, SEVERITY.HIGH);
  assert.equal(consentRejectVerdict({ requests: [], cookies: [{ name: 'session', domain: 'ex.com' }] }, 'x'), null);
});

function fakeBrowser(opts: { rejectSelector?: string; afterClick: string[]; cookies: string[] }): ConsentBrowser {
  let listener: ((r: ConsentRequest) => void) | null = null;
  const loc = (sel: string): ConsentLocator => ({
    first: () => loc(sel),
    isVisible: async () => sel === opts.rejectSelector,
    click: async () => {
      for (const u of opts.afterClick) listener?.({ url: () => u });
    },
  });
  const frame: ConsentFrame = { locator: loc };
  const page: ConsentPage = {
    locator: loc,
    goto: async () => {
      listener?.({ url: () => 'https://ex.com/page' });
    },
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    on: (_e, l) => {
      listener = l;
    },
    frames: () => [frame],
    mainFrame: () => frame,
  };
  return {
    newContext: async () => ({
      newPage: async () => page,
      cookies: async () => opts.cookies.map((name) => ({ name, domain: '.ex.com' })),
      close: async () => undefined,
    }),
  };
}

void test('ConsentRejectTest: trackers after reject ⇒ finding; no button ⇒ skipped', async () => {
  const bad = await ConsentRejectTest.probe(
    fakeBrowser({
      rejectSelector: '#onetrust-reject-all-handler',
      afterClick: ['https://connect.facebook.net/en_US/fbevents.js'],
      cookies: [],
    }),
    'https://ex.com/',
    { cmpWaitMs: 0 },
  );
  assert.equal(bad.issues.length, 1);
  assert.match(bad.issues[0].detail!, /OneTrust/);

  const none = await ConsentRejectTest.probe(fakeBrowser({ afterClick: [], cookies: ['_ga'] }), 'https://ex.com/');
  assert.equal(none.issues.length, 0);
  assert.equal(none.checks[0].status, 'skipped');
});

// ─── session replay ─────────────────────────────────────────────────────────

void test('session replay on sensitive pages', async () => {
  assert.deepEqual(detectReplayVendors(['https://static.hotjar.com/c/x.js', 'www.clarity.ms']), [
    'Hotjar',
    'Microsoft Clarity',
  ]);
  const r = SessionReplaySensitive.analyze([
    { url: 'https://ex.com/login', hasPasswordField: true, hasPaymentField: false, replayVendors: ['Hotjar'] },
    { url: 'https://ex.com/', hasPasswordField: false, hasPaymentField: false, replayVendors: ['Hotjar'] },
  ]);
  assert.equal(r.issues[0].message, 'Session replay runs on pages with password or payment fields');
  assert.equal(r.issues[0].severity, SEVERITY.MEDIUM);
  assert.equal(
    SessionReplaySensitive.analyze([
      { url: 'https://ex.com/login', hasPasswordField: true, hasPaymentField: false, replayVendors: [] },
    ]).issues.length,
    0,
  );
  const fields = await extractSensitiveFields({
    evaluate: async () => ({ hasPasswordField: true, hasPaymentField: false }) as never,
  });
  assert.equal(fields.hasPasswordField, true);
});
