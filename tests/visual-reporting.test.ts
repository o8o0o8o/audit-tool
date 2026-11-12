import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs, visualChildArgs } from '../lib/args-parser';
import { runAnalyzers } from '../lib/crawler/analyzer-runner';
import { BrokenMediaAnalyzer } from '../lib/analyzers/visual/broken-media-analyzer';
import { TextIntegrityAnalyzer } from '../lib/analyzers/visual/text-integrity-analyzer';
import { categorize } from '../lib/phase2/categorize';
import { buildReportMarkdown } from '../lib/phase2/phase2-runner';
import type { AuditArtifacts } from '../lib/phase2/types';
import { matchesChecks, resolvePreset } from '../lib/presets';
import { generateHTML } from '../generateHTML';
import { generateIssuesCSV } from '../generateCSV';
import { PageIndex, verifyFinding } from '../lib/phase3/finding-verifier';
import { checkFindingSignals, type LiveSignals } from '../lib/phase3/live-verifier';
import {
  buildCheckpointMetadata,
  checkpointVisual,
  resolveResumeVisual,
  type ProgressResults,
} from '../lib/orchestrators/progress-manager';
import { batchSiteOptions, loadConfig, resolveVisual, validateConfigFile } from '../lib/config-loader';
import type { ChromePage, PageInfo } from '../lib/types';
import type { CrawlerInternalOptions } from '../lib/crawler/crawler-types';

const root = path.join(__dirname, '..');
const PAGE = 'https://site.test/about';

const VISUAL_MESSAGES = [
  'Broken images detected',
  'Failed image or media requests',
  'Unrendered template tokens in page text',
  'Placeholder text (lorem ipsum) on page',
  'Garbled characters (mojibake) in page text',
  'Text clipped by its container',
];

const detail = (message: string) => ({
  severity: 'high',
  count: 1,
  examples: [`<a href="${PAGE}">${PAGE}</a> ${message.toLowerCase()}`],
});

function visualDetails(): Record<string, ReturnType<typeof detail>> {
  return Object.fromEntries(VISUAL_MESSAGES.map((m) => [m, detail(m)]));
}

function artifacts(details: Record<string, unknown>, visual: boolean | undefined): AuditArtifacts {
  return {
    runDir: fs.mkdtempSync(path.join(os.tmpdir(), 'visual-p2-')),
    manifest: {
      version: 1,
      format: 'multi',
      domain: 'site.test',
      created: '2026-01-01T00:00:00.000Z',
      progress: { processedPages: [PAGE], totalWithoutError: 1, totalWithError: 0, byError: {} },
      files: { metadata: '', analysis: '', incomingLinks: '', pageBatches: [] },
      evidence: null,
    },
    analysis: { overall: Object.keys(details), details, bySeverity: {}, summary: {} },
    metadata: { sitemaps: { total: 1 }, ...(visual === undefined ? {} : { visual }) },
    repoAnalysis: null,
  } as unknown as AuditArtifacts;
}

/** Write a legacy single-file audit plus metadata.json into a fresh run dir; return the rendered HTML. */
function renderHtml(details: Record<string, unknown>, visual: boolean | undefined): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-html-'));
  const auditFile = path.join(dir, 'audit.json');
  fs.writeFileSync(
    auditFile,
    JSON.stringify({
      robots: { sitemaps: [], 'user-agent': {} },
      sitemaps: { urls: {}, total: 1 },
      isMultiLang: false,
      timing: {},
      pageData: {
        pages: { [PAGE]: { url: PAGE, status: 200 } },
        processedPages: [PAGE],
        totalWithoutError: 1,
        totalWithError: 0,
        byError: {},
      },
      analysis: { overall: Object.keys(details), details, bySeverity: {}, summary: {} },
    }),
  );
  if (visual !== undefined) fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ visual }));
  const out = path.join(dir, 'site.test.html');
  generateHTML(auditFile, 'site.test', out);
  return fs.readFileSync(out, 'utf8');
}

void describe('--visual flag parse and runner gating', () => {
  void it('parses --visual / --no-visual and leaves it unset by default', () => {
    assert.equal(parseArgs(['--origin=https://site.test', '--visual']).visual, true);
    assert.equal(parseArgs(['--origin=https://site.test', '--no-visual']).visual, false);
    assert.equal(parseArgs(['--origin=https://site.test']).visual, null);
  });

  void it('lists --visual in completions.sh and the README', () => {
    assert.match(fs.readFileSync(path.join(root, 'completions.sh'), 'utf8'), / --visual /);
    assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /`--visual`/);
  });

  for (const visual of [false, true]) {
    void it(`runs the visual analyzers only with --visual (visual=${visual})`, async () => {
      const calls: string[] = [];
      const origBroken = BrokenMediaAnalyzer.analyze.bind(BrokenMediaAnalyzer);
      const origText = TextIntegrityAnalyzer.analyze.bind(TextIntegrityAnalyzer);
      BrokenMediaAnalyzer.analyze = () => {
        calls.push('broken');
        return Promise.resolve({
          brokenImages: [PAGE],
          brokenMedia: [],
          failedRequests: [],
          issues: [{ severity: 'high', message: 'Broken images detected', detail: PAGE }],
        });
      };
      TextIntegrityAnalyzer.analyze = () => {
        calls.push('text');
        return Promise.resolve({
          templateTokens: ['{{ x }}'],
          placeholderText: false,
          mojibake: [],
          clippedText: [],
          issues: [{ severity: 'high', message: 'Unrendered template tokens in page text', detail: PAGE }],
        });
      };
      const reported: string[] = [];
      const chromePage = new Proxy(
        {},
        {
          get: () => () => {
            const failed = Promise.reject(new Error('no browser in unit test'));
            failed.catch(() => undefined);
            return failed;
          },
        },
      ) as unknown as ChromePage;
      const pageData = { url: PAGE } as unknown as PageInfo;
      try {
        await runAnalyzers(
          chromePage,
          { querySelectorAll: () => [], querySelector: () => null } as never,
          PAGE,
          pageData,
          '<html></html>',
          {},
          {},
          { origin: 'https://site.test', analysis: {}, perf: false } as unknown as CrawlerInternalOptions,
          (message: string) => reported.push(message),
          undefined,
          visual,
        );
      } finally {
        BrokenMediaAnalyzer.analyze = origBroken;
        TextIntegrityAnalyzer.analyze = origText;
      }
      if (visual) {
        assert.deepEqual(calls.sort(), ['broken', 'text']);
        assert.ok(reported.includes('Broken images detected'), reported.join('|'));
        assert.ok(reported.includes('Unrendered template tokens in page text'));
        assert.ok(pageData.brokenMediaData);
      } else {
        assert.deepEqual(calls, []);
        for (const m of VISUAL_MESSAGES) assert.ok(!reported.includes(m), m);
        assert.equal(pageData.brokenMediaData, undefined);
        assert.equal(pageData.textIntegrityData, undefined);
      }
    });
  }
});

void describe('html report and issues_breakdown.csv', () => {
  void it('html: shows the visual findings with the affected page', () => {
    const html = renderHtml(visualDetails(), true);
    for (const m of VISUAL_MESSAGES) assert.ok(html.includes(m), m);
    assert.ok(html.includes(PAGE));
  });

  void it('html: issues_breakdown.csv lists the visual findings with example URLs', () => {
    const csv = generateIssuesCSV({ analysis: { details: visualDetails() } } as never);
    for (const m of VISUAL_MESSAGES) {
      const row = csv.split('\n').find((l) => l.startsWith(m) || l.startsWith(`"${m}"`));
      assert.ok(row, m);
      assert.ok(row.includes(PAGE), row);
    }
  });
});

void describe('phase 2 routing and preset filters', () => {
  void it('preset: categorize routes every visual finding to ux', () => {
    for (const m of VISUAL_MESSAGES) assert.equal(categorize(m), 'ux', m);
  });

  for (const name of ['sales', 'marketing', 'seo'] as const) {
    void it(`preset: ${name} keeps and renders the visual findings`, () => {
      const r = resolvePreset(name);
      assert.ok(r.phase2Sections === undefined || r.phase2Sections.includes('ux'), `${name} renders ux`);
      for (const m of VISUAL_MESSAGES) assert.ok(matchesChecks(m, categorize(m), r.checks), `${name}: ${m}`);
      const md = buildReportMarkdown(artifacts(visualDetails(), true), {}, [], new Set(), undefined, undefined, false, {
        preset: name,
        sections: r.phase2Sections,
        checks: r.checks,
      });
      for (const m of VISUAL_MESSAGES) assert.ok(md.includes(m), `${name} report lists ${m}`);
    });
  }
});

void describe('phase 3 never refutes visual findings', () => {
  void it('refute: the crawl-data verifier leaves them unchecked', () => {
    const pages = new PageIndex();
    pages.add(PAGE, { url: PAGE } as unknown as PageInfo);
    for (const m of VISUAL_MESSAGES) {
      const v = verifyFinding(m, detail(m) as never, pages);
      assert.equal(v.status, 'unchecked', m);
    }
  });

  void it('refute: the live checker leaves them unverified', () => {
    const signals = { finalUrl: PAGE, status: 200 } as unknown as LiveSignals;
    for (const m of VISUAL_MESSAGES) assert.equal(checkFindingSignals(m, signals).status, 'unverified', m);
  });
});

void describe('empty-state note', () => {
  const NOTE = 'No UI issues found';

  void it('note: shown in the HTML and Phase 2 reports when --visual ran clean', () => {
    assert.ok(renderHtml({}, true).includes(NOTE));
    const md = buildReportMarkdown(artifacts({}, true));
    assert.ok(md.includes(NOTE));
  });

  void it('note: absent without --visual, for legacy runs, and when visual findings exist', () => {
    assert.ok(!renderHtml({}, false).includes(NOTE));
    assert.ok(!renderHtml({}, undefined).includes(NOTE));
    assert.ok(!renderHtml(visualDetails(), true).includes(NOTE));
    assert.ok(!buildReportMarkdown(artifacts({}, false)).includes(NOTE));
    assert.ok(!buildReportMarkdown(artifacts({}, undefined)).includes(NOTE));
    assert.ok(!buildReportMarkdown(artifacts(visualDetails(), true)).includes(NOTE));
  });
});

void describe('resume, config and batch forwarding', () => {
  void it('resume: start.ts forwards --visual and --no-visual to the child', () => {
    assert.deepEqual(visualChildArgs(true), ['--visual']);
    assert.deepEqual(visualChildArgs(false), ['--no-visual']);
    assert.deepEqual(visualChildArgs(null), []);
    // Round-trip: the forwarded flags parse back to the same choice in the child.
    assert.equal(parseArgs(['--origin=https://example.com', ...visualChildArgs(true)]).visual, true);
    assert.equal(parseArgs(['--origin=https://example.com', ...visualChildArgs(false)]).visual, false);
  });

  void it('resume: the checkpoint value wins and a legacy checkpoint counts as off', () => {
    assert.equal(checkpointVisual({ visual: true }), true);
    assert.equal(checkpointVisual({}), false);
    assert.equal(checkpointVisual(null), false);
    assert.deepEqual(resolveResumeVisual(true, true), { visual: true, warning: null });
    const mismatch = resolveResumeVisual(true, false);
    assert.equal(mismatch.visual, false);
    assert.ok(mismatch.warning);
    assert.equal(resolveResumeVisual(false, true).visual, true);
  });

  void it('resume: the checkpoint metadata records visual', () => {
    const base = { robots: {}, sitemaps: {}, pageData: { pages: {}, processedPages: [] } } as unknown as ProgressResults;
    assert.equal(buildCheckpointMetadata({ ...base, visual: true }).visual, true);
    assert.equal(buildCheckpointMetadata(base).visual, false);
    assert.equal(checkpointVisual(buildCheckpointMetadata({ ...base, visual: true })), true);
  });

  void it('resume: .seoauditrc visual is loaded, validated and overridden by the CLI', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-rc-'));
    const rc = path.join(dir, '.seoauditrc');
    fs.writeFileSync(rc, JSON.stringify({ visual: true }));
    const config = loadConfig(rc);
    assert.equal(config.visual, true);
    const validation = validateConfigFile(rc);
    assert.ok(!validation.warnings.some((w) => w.includes('visual')), validation.warnings.join('|'));
    assert.equal(resolveVisual(null, config), true);
    assert.equal(resolveVisual(false, config), false);
    assert.equal(resolveVisual(null, {}), false);
    assert.equal(resolveVisual(true, {}), true);
  });

  void it('resume: --sites passes visual to each site audit', () => {
    assert.equal(batchSiteOptions({ visual: true }, {}).visual, true);
    assert.equal(batchSiteOptions({ visual: false }, { visual: true }).visual, false);
    assert.equal(batchSiteOptions({ visual: null }, { visual: true }).visual, true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-sites-'));
    const rc = path.join(dir, '.seoauditrc');
    fs.writeFileSync(rc, JSON.stringify({ visual: true }));
    const opts = batchSiteOptions({ config: rc });
    assert.equal(opts.visual, true);
    assert.equal(opts.limit, 20);
  });
});
