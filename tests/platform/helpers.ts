import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { DispatchRequest, Dispatcher } from '../../web/lib/platform/types';
import { LocalFileStore } from '../../web/lib/platform/local/file-store';

export const SECRET = 'test-secret-'.padEnd(40, 'x');

export class FakeDispatcher implements Dispatcher {
  requests: DispatchRequest[] = [];
  states = new Map<string, 'waiting' | 'running' | 'gone'>();
  cancelled: string[] = [];
  refuse = false;
  async dispatch(req: DispatchRequest) {
    if (this.refuse) {
      const { DispatchUnavailable } = await import('../../web/lib/platform/types');
      throw new DispatchUnavailable('refused');
    }
    this.requests.push(req);
  }
  async state(id: string, attempt: number) {
    return this.states.get(`${id}:${attempt}`) ?? 'gone';
  }
  async cancel(id: string, attempt: number) {
    this.cancelled.push(`${id}:${attempt}`);
  }
}

export function tempStore(appUrl = 'http://127.0.0.1:9'): { store: LocalFileStore; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'platform-files-'));
  return {
    store: new LocalFileStore(dir, { appUrl, secret: SECRET }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface FixtureRunOptions {
  domain?: string;
  /** Pages answered with a bot challenge (by path). */
  blockedPaths?: string[];
  homepageBlocked?: boolean;
  lead?: boolean;
  findings?: Record<string, { severity: string; count: number; examples: string[]; siteWide?: unknown }>;
  siteChecks?: Array<{ id: string; label: string; status: string; note?: string; details?: unknown[] }>;
  gateRun?: object;
}

/** Writes a small run folder in the shape the audit tool writes (multi-file, gzipped). */
export function writeFixtureRun(opts: FixtureRunOptions = {}): { runDir: string; cleanup: () => void } {
  const domain = opts.domain ?? 'fixture.example';
  const base = mkdtempSync(path.join(os.tmpdir(), 'fixture-run-'));
  const runDir = path.join(base, opts.lead ? 'lead-results' : 'audit-results', domain, '2026-11-20_10-00-00');
  mkdirSync(path.join(runDir, 'pages'), { recursive: true });
  const gz = (f: string, v: unknown) => writeFileSync(path.join(runDir, f), gzipSync(JSON.stringify(v)));
  const origin = `https://${domain}`;
  const paths = ['/', '/about', '/pricing', '/contact', '/blog'];
  const blocked = new Set([...(opts.blockedPaths ?? []), ...(opts.homepageBlocked ? ['/'] : [])]);
  const pages: Record<string, unknown> = {};
  for (const p of paths) {
    const url = origin + p;
    pages[url] = {
      url,
      status: blocked.has(p) ? 403 : 200,
      title: `Page ${p}`,
      languageDetection: { htmlLang: 'en' },
      structuredData: { jsonLdSchemas: [{ type: 'Organization' }] },
      security: { headers: { 'strict-transport-security': 'max-age=1' } },
      caching: { cdnProvider: 'Cloudflare' },
      formData: { formCount: p === '/contact' ? 1 : 0 },
      tagRuntime: { ga4Ids: ['G-TEST123'], hits: 2, gtmIds: ['GTM-ABC'], metaPixelIds: [] },
      technologies: { technologies: [{ name: 'WordPress', category: 'CMS', confidence: 'high' }] },
      ctas: [{ text: 'Book a demo', href: 'https://calendly.com/x', aboveFold: true }],
      links: ['https://calendly.com/x'],
    };
  }
  writeFileSync(
    path.join(runDir, 'pages', 'batch_0001.json.gz'),
    gzipSync(JSON.stringify({ batchIndex: 1, urls: Object.keys(pages), pages })),
  );
  const byError: Record<string, string[]> = {};
  if (blocked.size) byError['403'] = [...blocked].map((p) => origin + p);
  gz('manifest.json.gz', {
    version: 2,
    format: 'multi-file',
    domain,
    progress: {
      processedPages: Object.keys(pages),
      totalWithoutError: paths.length - blocked.size,
      totalWithError: blocked.size,
      byError,
      attempts: {},
    },
    files: {
      metadata: 'metadata.json.gz',
      analysis: 'analysis.json.gz',
      pageBatches: [{ file: 'pages/batch_0001.json.gz', count: paths.length, urls: Object.keys(pages) }],
    },
    evidence: {},
  });
  gz('metadata.json.gz', {
    robots: {
      sitemaps: [`${origin}/sitemap.xml`],
      'user-agent': { '*': { allow: [], disallow: [] }, GPTBot: { allow: [], disallow: ['/'] } },
    },
    sitemaps: { urls: {}, total: 5 },
    timing: { startTime: '2026-11-20T10:00:00.000Z', endTime: '2026-11-20T10:01:00.000Z', elapsedTime: 60000 },
    cruxData: {
      target: origin,
      targetType: 'origin',
      formFactor: 'PHONE',
      metrics: {
        LCP: { percentiles: { p75: 2100 } },
        CLS: { percentiles: { p75: '0.05' } },
        INP: { percentiles: { p75: 150 } },
      },
    },
    crawlProfile: { perf: false },
    siteChecks: {
      checks: opts.siteChecks ?? [
        { id: 'spf', label: 'SPF', status: 'pass', note: 'v=spf1 -all' },
        { id: 'dmarc', label: 'DMARC', status: 'warn', note: 'p=none' },
      ],
    },
    ...(opts.lead
      ? {
          leadScan: {
            cap: 25,
            home: `${origin}/`,
            selected: paths.map((p) => ({ url: origin + p, reason: p === '/' ? 'homepage' : 'nav' })),
            requests: { total: 40 },
          },
          passive: true,
        }
      : {}),
  });
  const ex = (p: string, text: string) => `<a href="${origin}${p}">${origin}${p}</a> ${text}`;
  gz('analysis.json.gz', {
    overall: [],
    details: opts.findings ?? {
      'Missing meta description': {
        severity: 'high',
        count: 2,
        examples: [ex('/about', 'has no description'), ex('/pricing', 'has no description')],
      },
      'Some pages have too many requests': {
        severity: 'medium',
        count: 3,
        examples: [ex('/', 'has 63 requests'), ex('/blog', 'has 70 requests')],
      },
      'No CAA record': { severity: 'low', count: 1, examples: ['No CAA record for fixture.example'] },
      'Only blocked page issue': { severity: 'high', count: 1, examples: [ex('/contact', 'broken')] },
    },
    summary: {
      overallScore: 71,
      categoryScores: { seo: 80, performance: 60, accessibility: 90, security: 70, technical: 85 },
      quickWins: [
        {
          issue: 'Missing meta description',
          impact: 'High',
          effort: '15 minutes',
          fix: 'Write descriptions',
          affectedPages: 2,
        },
      ],
    },
  });
  if (opts.gateRun) {
    mkdirSync(path.join(runDir, 'lead', 'gate-runs'), { recursive: true });
    writeFileSync(
      path.join(runDir, 'lead', 'gate-runs', '2026-11-20T10-02-00-000Z.json'),
      JSON.stringify(opts.gateRun),
    );
  }
  writeFileSync(
    path.join(runDir, `${domain}.html`),
    `<html><body><h1>Report for ${domain}</h1><img src="evidence/x/screenshot.png"></body></html>`,
  );
  return { runDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export const GATE_RUN = {
  checkedAt: '2026-11-20T10:02:00.000Z',
  teaserReady: true,
  highlights: [
    {
      type: 'dead-nav-link',
      rootCause: 'dead-navigation-links',
      weight: 'heavy',
      fact: 'The Pricing link in the main menu answers 404.',
      url: 'https://fixture.example/',
      evidence: { methods: ['http-get'] },
    },
    {
      type: 'email-auth',
      rootCause: 'email-auth',
      weight: 'medium',
      fact: 'No DMARC policy.',
      url: null,
      evidence: {},
    },
    {
      type: 'end-of-life',
      rootCause: 'end-of-life',
      weight: 'light',
      fact: 'PHP 7.4 is past end of life.',
      url: 'https://fixture.example/',
      evidence: {},
    },
  ],
  candidatesDropped: [],
  disclosure: [],
};
