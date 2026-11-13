/**
 * Lead mode must not change the full audit. These tests pin what a run WITHOUT `--lead` /
 * `--passive` does, so any lead-scan change that leaks into the default path fails here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'node-html-parser';
import { LEAD_MODE, leadChildArgs, parseArgs } from '../lib/args-parser';
import { anchorsOf, buildSiteHints, linkPosition } from '../lib/analyzers/site-checks/crawl-hints';
import type { HttpProbeFetcher } from '../lib/analyzers/site-checks/http-probe';
import { JsSecretsScanner } from '../lib/analyzers/site-checks/js-secrets-scanner';
import {
  PASSIVE_NOTE,
  PASSIVE_SKIPPED_STEPS,
  runSiteProbes,
  siteProbeSteps,
} from '../lib/analyzers/site-checks/site-probes';
import { WordPressPluginsAnalyzer } from '../lib/analyzers/site-checks/wordpress-plugins';
import { RepresentativeSampler } from '../lib/crawler/representative-sampler';
import { RequestCounter } from '../lib/leads/request-counter';
import { buildCheckpointMetadata, type ProgressResults } from '../lib/orchestrators/progress-manager';
import { DEFAULT_RESULTS_BASE } from '../lib/seo-data';
import type { ParsedPage } from '../lib/types';

/** `parseArgs(['--origin=https://example.com'])` as it was before lead mode existed, plus the two new flags, both off. */
const DEFAULT_ARGS = {
  origin: 'https://example.com',
  compare: null,
  sitemap: null,
  compareSitemap: null,
  proceed: false,
  perf: false,
  saveHtml: false,
  screenshots: false,
  concurrency: 5,
  concurrencyExplicit: false,
  heapSize: null,
  config: null,
  initConfig: false,
  repo: null,
  exclude: [],
  limit: null,
  dryRun: false,
  generateCi: false,
  validateConfig: false,
  webhook: null,
  version: false,
  help: false,
  open: false,
  verbose: false,
  preset: null,
  sections: [],
  checks: [],
  sites: null,
  slack: null,
  watch: null,
  brandLogo: null,
  brandName: null,
  ci: null,
  json: false,
  phase2: true,
  llmNarrative: false,
  llmFindings: false,
  llmRepo: false,
  llmVerify: false,
  verify: false,
  visual: null,
  agentic: null,
  noScore: false,
  evidence: true,
  evidenceCap: 10,
  lead: false,
  passive: false,
  contentResearch: false,
  competitors: null,
  warnings: [],
  errors: [],
};

const ALL_STEPS = [
  'email/DNS',
  'exposed files',
  'missing-page status',
  'subdomain takeover',
  'staging hosts',
  'abandoned script domains',
  'JS secrets',
  'open buckets',
  'CORS',
  'WordPress plugins',
  'bot parity',
  'locale redirect',
  'GA4 hits',
  'GTM container',
  'session replay',
  'browser probes',
];

const stepNames = (ctx: Parameters<typeof siteProbeSteps>[2]) =>
  siteProbeSteps('https://example.com', {}, ctx).map(([name]) => name);

void describe('full audit is unchanged by lead mode', () => {
  void it('default arguments are what they were', () => {
    assert.deepEqual(parseArgs(['--origin=https://example.com']), DEFAULT_ARGS);
  });

  void it('a full audit writes to audit-results and a lead scan to its own folder', () => {
    assert.equal(DEFAULT_RESULTS_BASE, 'audit-results');
    assert.equal(LEAD_MODE.resultsBase, 'lead-results');
    assert.notEqual(LEAD_MODE.resultsBase, DEFAULT_RESULTS_BASE);
  });

  void it('without --passive every site probe runs, in the original order', () => {
    assert.deepEqual(stepNames({}), ALL_STEPS);
    assert.deepEqual(stepNames({ passive: false }), ALL_STEPS);
  });

  void it('a full audit checkpoint carries no lead or passive keys', () => {
    const results = { robots: {}, sitemaps: {}, visual: false, pageData: {} } as unknown as ProgressResults;
    assert.deepEqual(Object.keys(buildCheckpointMetadata(results)), [
      'robots',
      'sitemaps',
      'isMultiLang',
      'timing',
      'cruxData',
      'crawlProfile',
      'visual',
      'siteChecks',
    ]);
    const lead = buildCheckpointMetadata({ ...results, passive: true, leadScan: { cap: 25 } } as ProgressResults);
    assert.equal((lead as Record<string, unknown>).passive, true);
    assert.deepEqual((lead as Record<string, unknown>).leadScan, { cap: 25 });
  });

  void it('evidence sampling buckets by the first path segment unless a lead scan asks otherwise', () => {
    const full = new RepresentativeSampler(10);
    assert.equal(full.shouldSample('https://example.com/en/blog/a'), true);
    assert.equal(full.shouldSample('https://example.com/en/pricing/plans'), false, 'same /en/* bucket, as before');

    const lead = new RepresentativeSampler(10, { ignoreLanguagePrefix: true });
    assert.equal(lead.shouldSample('https://example.com/en/blog/a'), true);
    assert.equal(lead.shouldSample('https://example.com/en/pricing/plans'), true, 'a different template');
    assert.equal(lead.shouldSample('https://example.com/de/blog/b'), false, 'the blog template again');
  });

  void it('navigation links are stored only when asked for', () => {
    const page = parse(
      '<header><nav><a href="/pricing">Pricing</a></nav></header><main><a href="/blog/a">Post</a></main><footer><nav><a href="/legal">Legal</a></nav></footer>',
    ) as unknown as ParsedPage;
    const anchors = anchorsOf(page, 'https://example.com/');
    assert.deepEqual(
      anchors.map((a) => a.position),
      ['header', 'main', 'footer'],
    );
    assert.equal(linkPosition(page.querySelector('footer a')), 'footer');

    assert.equal('navLinks' in buildSiteHints('https://example.com/', {}, anchors), false);
    const withNav = buildSiteHints('https://example.com/', {}, anchors, { navLinks: true });
    assert.deepEqual(
      withNav.navLinks?.map((a) => `${a.position}:${a.href}`),
      ['header:https://example.com/pricing', 'footer:https://example.com/legal'],
    );
  });
});

void describe('--lead and --passive arguments', () => {
  void it('--lead sets a small, passive run with no curated report', () => {
    const args = parseArgs(['--origin=https://example.com', '--lead']);
    assert.equal(args.lead, true);
    assert.equal(args.passive, true);
    assert.equal(args.limit, 25);
    assert.equal(args.concurrency, 3);
    assert.equal(args.visual, true);
    assert.equal(args.evidenceCap, 5);
    assert.equal(args.phase2, false);
    assert.equal(args.perf, false);
    assert.deepEqual(args.errors, []);
  });

  void it('the page cap is a ceiling: --limit can lower it, never raise it', () => {
    assert.equal(parseArgs(['--origin=https://example.com', '--lead', '--limit=8']).limit, 8);
    assert.equal(parseArgs(['--origin=https://example.com', '--limit=500', '--lead']).limit, 25);
    // An explicit --concurrency is also checked against free memory, so only the ceiling is asserted.
    assert.ok(parseArgs(['--origin=https://example.com', '--lead', '--concurrency=2']).concurrency <= 2);
    assert.ok(parseArgs(['--origin=https://example.com', '--lead', '--concurrency=10']).concurrency <= 3);
    assert.equal(parseArgs(['--origin=https://example.com', '--lead', '--evidence-cap=2']).evidenceCap, 2);
    assert.equal(parseArgs(['--origin=https://example.com', '--lead', '--no-visual']).visual, false);
  });

  void it('--lead drops the lab run, verification and LLM passes with a warning, and refuses comparison runs', () => {
    const args = parseArgs([
      '--origin=https://example.com',
      '--lead',
      '--perf',
      '--verify',
      '--llm',
      '--content-research',
    ]);
    assert.equal(args.perf || args.verify || args.llmNarrative || args.contentResearch, false);
    assert.match(args.warnings.join(' '), /--lead ignores --perf .*--verify, --llm, --content-research/);
    const bad = parseArgs(['--origin=https://example.com', '--lead', '--compare=https://other.example']);
    assert.match(bad.errors.join(' '), /--lead cannot be combined with --compare/);
  });

  void it('--passive alone changes nothing but the probes', () => {
    const args = parseArgs(['--origin=https://example.com', '--passive']);
    assert.deepEqual({ ...args, passive: false }, DEFAULT_ARGS);
  });

  void it('a restart keeps the mode, and what start.ts forwards parses back to the same run', () => {
    assert.deepEqual(leadChildArgs({ lead: true, passive: true }), ['--lead']);
    assert.deepEqual(leadChildArgs({ lead: false, passive: true }), ['--passive']);
    assert.deepEqual(leadChildArgs({ lead: false, passive: false }), []);
    const first = parseArgs(['--origin=https://example.com', '--lead']);
    const child = parseArgs([
      '--origin=https://example.com',
      '--lead',
      '--limit=25',
      '--concurrency=3',
      '--visual',
      '--evidence-cap=5',
      '--no-phase2',
    ]);
    // Concurrency is left out: an explicit value is also capped by free memory at the time of the run.
    const comparable = (a: typeof first) => ({ ...a, concurrency: 0, concurrencyExplicit: false, warnings: [] });
    assert.deepEqual(comparable(child), comparable(first));
    assert.ok(child.concurrency <= 3);
  });
});

void describe('passive site probes', () => {
  void it('skips every probe that goes beyond reading published pages', () => {
    const passive = stepNames({ passive: true });
    for (const off of ['exposed files', 'staging hosts', 'open buckets', 'CORS', 'bot parity', 'locale redirect']) {
      assert.equal(passive.includes(off), false, off);
      assert.ok(off in PASSIVE_SKIPPED_STEPS, off);
    }
    assert.deepEqual(
      passive,
      ALL_STEPS.filter((s) => !(s in PASSIVE_SKIPPED_STEPS)),
    );
  });

  void it('scans public scripts for keys but never queries a Firebase database named in them', async () => {
    const asked: string[] = [];
    const fetcher: HttpProbeFetcher = async (url) => {
      asked.push(url);
      return {
        status: 200,
        url,
        headers: {},
        body: 'firebase.initializeApp({ databaseURL: "https://demo-app.firebaseio.com" });',
      };
    };
    const passive = await JsSecretsScanner.scan(['https://example.com/app.js'], fetcher, { checkFirebase: false });
    assert.deepEqual(asked, ['https://example.com/app.js']);
    assert.match(passive.checks[0].note ?? '', /found, not queried \(passive mode\)/);

    asked.length = 0;
    await JsSecretsScanner.scan(['https://example.com/app.js'], fetcher);
    assert.ok(
      asked.some((u) => u.includes('firebaseio.com/.json')),
      'the full audit still checks the database',
    );
  });

  void it('reads WordPress plugin versions from asset URLs without requesting readme files', async () => {
    const asked: string[] = [];
    const fetcher: HttpProbeFetcher = async (url) => {
      asked.push(url);
      return { status: 200, url, headers: {}, body: 'Stable tag: 9.9.9' };
    };
    const plugins = new Map<string, string | null>([['contact-form-7', '5.8']]);
    const passive = await WordPressPluginsAnalyzer.analyze('https://example.com', plugins, fetcher, undefined, {
      readReadme: false,
    });
    assert.deepEqual(asked, []);
    assert.match(passive.checks[0].note ?? '', /contact-form-7 5\.8/);

    await WordPressPluginsAnalyzer.analyze('https://example.com', plugins, fetcher, undefined);
    assert.deepEqual(asked, ['https://example.com/wp-content/plugins/contact-form-7/readme.txt']);
  });

  void it('a passive run sends nothing but the missing-page request, and reports what it left out', async () => {
    const originalFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      asked.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    try {
      // An IP origin has no DNS checks; skipBrowser keeps the test offline.
      const data = await runSiteProbes('http://127.0.0.1:9', {}, () => undefined, { passive: true, skipBrowser: true });
      assert.equal(data.passive, true);
      assert.equal(asked.length, 1, `only the missing-page probe: ${asked.join(', ')}`);
      assert.match(asked[0], /^http:\/\/127\.0\.0\.1:9\/[a-z0-9-]+/i);
      for (const pattern of [/\.env/, /\.git/, /phpinfo/, /\.json\?shallow/, /readme\.txt/, /crt\.sh/]) {
        assert.equal(
          asked.some((u) => pattern.test(u)),
          false,
          String(pattern),
        );
      }
      const skipped = data.checks.filter((c) => c.note === PASSIVE_NOTE).map((c) => c.id);
      assert.deepEqual(skipped.sort(), [
        'ai-crawler-access',
        'consent-reject',
        'cors',
        'exposed-files',
        'googlebot-parity',
        'locale-redirect',
        'open-buckets',
        'staging-hosts',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

void describe('request counter', () => {
  void it('counts requests to the site and its subdomains, from the browser and from fetch', async () => {
    const counter = new RequestCounter('www.example.com');
    counter.observeBrowser('https://example.com/');
    counter.observeBrowser('https://cdn.example.com/app.js');
    counter.observeBrowser('https://www.googletagmanager.com/gtm.js');
    counter.observeBrowser('not a url');
    assert.equal(counter.isSiteUrl('https://notexample.com/'), false);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
    try {
      counter.installFetch();
      counter.installFetch(); // idempotent
      await fetch('https://example.com/robots.txt');
      await fetch(new URL('https://example.com/sitemap.xml'));
      await fetch('https://chromeuxreport.googleapis.com/v1/records:queryRecord');
      counter.uninstallFetch();
      await fetch('https://example.com/after');
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(counter.counts, { browser: 2, node: 2, total: 4 });
  });
});
