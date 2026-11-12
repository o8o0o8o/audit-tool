import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs } from '../lib/args-parser';
import { generateHTML } from '../generateHTML';
import { buildReportMarkdown, preparedDetails } from '../lib/phase2/phase2-runner';
import type { AuditArtifacts } from '../lib/phase2/types';
import { loadPhase2State } from '../lib/phase3/verify-runner';
import { goldenDir, renderNoPresetHtml, renderNoPresetMarkdown } from './fixtures/report-fixture/make-golden';
import {
  PRESET_NAMES,
  PresetError,
  ROLE_DEFINITIONS,
  applyPresetRunOptions,
  findingCheckGroups,
  resolvePreset,
} from '../lib/presets';

void describe('parseArgs --preset', () => {
  for (const name of ['quick', 'standard', 'deep', 'sales', 'marketing', 'seo', 'custom']) {
    void it(`accepts --preset=${name}`, () => {
      const args = parseArgs([`--preset=${name}`]);
      assert.equal(args.preset, name);
      assert.deepEqual(args.errors, []);
    });
  }

  void it('rejects an unknown preset with an error listing every valid preset', () => {
    const args = parseArgs(['--preset=bogus']);
    assert.equal(args.preset, null);
    assert.equal(args.errors.length, 1);
    for (const name of PRESET_NAMES) assert.match(args.errors[0], new RegExp(`\\b${name}\\b`));
  });

  void it('parses --sections and --checks as lowercased CSV lists', () => {
    const args = parseArgs(['--preset=custom', '--sections=Top-Issues, performance', '--checks=seo,cta']);
    assert.deepEqual(args.sections, ['top-issues', 'performance']);
    assert.deepEqual(args.checks, ['seo', 'cta']);
  });
});

void describe('resolvePreset', () => {
  void it('no preset and speed presets keep the full report', () => {
    for (const name of [null, 'quick', 'standard', 'deep']) {
      const r = resolvePreset(name);
      assert.equal(r.sections, undefined);
      assert.equal(r.checks, undefined);
      assert.equal(r.phase2Sections, undefined);
      assert.equal(r.htmlSections, undefined);
    }
  });

  void it('sales leads with summary, tech stack, CTAs and top issues and excludes accessibility', () => {
    const r = resolvePreset('sales');
    assert.deepEqual(r.sections?.slice(0, 4), ['executive-summary', 'technology-stack', 'cta', 'top-issues']);
    assert.ok(!r.sections?.includes('accessibility'));
    assert.ok(!r.phase2Sections?.includes('accessibility'));
    assert.deepEqual(r.htmlSections?.slice(0, 4), [
      'executive-summary',
      'technology-stack',
      'content-insights',
      'issues-detail',
    ]);
    assert.deepEqual(r.checks, [...ROLE_DEFINITIONS.sales.checks!]);
  });

  void it('seo covers every technical SEO section without a finding filter', () => {
    const r = resolvePreset('seo');
    for (const s of ['seo', 'technical', 'performance', 'accessibility'] as const) assert.ok(r.sections?.includes(s));
    assert.equal(r.checks, undefined);
  });

  void it('custom returns exactly the selection, in the given order', () => {
    const r = resolvePreset('custom', { sections: ['privacy', 'seo', 'privacy'], checks: ['security'] });
    assert.deepEqual(r.sections, ['privacy', 'seo']);
    assert.deepEqual(r.phase2Sections, ['privacy', 'seo']);
    assert.deepEqual(r.htmlSections, []);
    assert.deepEqual(r.checks, ['security']);
  });

  void it('custom with only checks keeps every section', () => {
    const r = resolvePreset('custom', { checks: ['performance'] });
    assert.equal(r.sections, undefined);
    assert.deepEqual(r.checks, ['performance']);
  });

  void it('errors on unknown preset, section or check', () => {
    assert.throws(() => resolvePreset('bogus'), PresetError);
    assert.throws(() => resolvePreset('custom', { sections: ['nope'] }), /Unknown section "nope"/);
    assert.throws(() => resolvePreset('custom', { checks: ['nope'] }), /Unknown check "nope"/);
  });

  void it('errors on --sections/--checks with a non-custom preset and on an empty custom selection', () => {
    assert.throws(() => resolvePreset('sales', { sections: ['seo'] }), /only valid with --preset=custom/);
    assert.throws(() => resolvePreset(null, { checks: ['seo'] }), /only valid with --preset=custom/);
    assert.throws(() => resolvePreset('custom'), /needs a selection/);
  });
});

void describe('applyPresetRunOptions', () => {
  const base = () => ({ perf: false, saveHtml: false, limit: null, concurrency: 5, concurrencyExplicit: false });

  void it('quick keeps an explicit concurrency and limit', () => {
    const args = { ...base(), concurrency: 7, concurrencyExplicit: true, limit: 5 as number | null };
    applyPresetRunOptions(args, resolvePreset('quick'));
    assert.equal(args.concurrency, 7);
    assert.equal(args.limit, 5);
    assert.equal(args.perf, false);
  });

  void it('deep enables perf and HTML snapshots', () => {
    const args: ReturnType<typeof base> & { limit: number | null } = base();
    applyPresetRunOptions(args, resolvePreset('deep'));
    assert.deepEqual(args, { perf: true, saveHtml: true, limit: null, concurrency: 3, concurrencyExplicit: false });
  });
});

void describe('preset report rendering', () => {
  const fixtureDir = path.join(__dirname, 'fixtures', 'report-fixture');
  const auditFile = path.join(fixtureDir, 'audit.json');

  function fixtureArtifacts(): AuditArtifacts {
    const audit = JSON.parse(fs.readFileSync(auditFile, 'utf8')) as Record<string, unknown>;
    const pageData = audit.pageData as { processedPages?: string[] } & Record<string, unknown>;
    return {
      runDir: fixtureDir,
      manifest: {
        version: 1,
        format: 'multi',
        domain: 'fixture.example',
        created: '2026-01-01T00:00:00.000Z',
        progress: { ...pageData, processedPages: pageData.processedPages ?? [] },
        files: { metadata: '', analysis: '', incomingLinks: '', pageBatches: [] },
        evidence: null,
      },
      analysis: audit.analysis,
      metadata: { robots: audit.robots, sitemaps: audit.sitemaps, timing: audit.timing },
      repoAnalysis: null,
    } as unknown as AuditArtifacts;
  }

  function renderMd(name: string, selection: { sections?: string[]; checks?: string[] } = {}): string {
    const r = resolvePreset(name, selection);
    return buildReportMarkdown(fixtureArtifacts(), {}, [], new Set(), undefined, undefined, false, {
      sections: r.phase2Sections,
      checks: r.checks,
    });
  }

  function renderHtml(name: string | null, selection: { sections?: string[]; checks?: string[] } = {}): string {
    const r = resolvePreset(name, selection);
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'preset-html-')), 'index.html');
    generateHTML(auditFile, 'fixture.example', out, undefined, { sections: r.htmlSections, checks: r.checks });
    return fs.readFileSync(out, 'utf8');
  }

  void it('no preset matches the golden markdown and HTML', () => {
    assert.equal(renderNoPresetMarkdown(), fs.readFileSync(path.join(goldenDir, 'no-preset.md'), 'utf8'));
    assert.equal(renderNoPresetHtml(), fs.readFileSync(path.join(goldenDir, 'no-preset.html'), 'utf8'));
  });

  void it('sales markdown keeps only its sections', () => {
    const md = renderMd('sales');
    assert.match(md, /^## Performance Audit$/m);
    assert.doesNotMatch(md, /^## SEO Audit$/m);
    assert.doesNotMatch(md, /^## Accessibility Audit$/m);
  });

  void it('sales HTML renders its sections in preset order and drops the rest', () => {
    const html = renderHtml('sales');
    const ids = ['executive-summary', 'technology-stack', 'content-insights', 'issues-detail', 'performance'];
    const positions = ids.map((id) => html.indexOf(`<div id="${id}">`));
    for (const p of positions) assert.ok(p > 0);
    assert.deepEqual(
      [...positions].sort((a, b) => a - b),
      positions,
    );
    assert.ok(!html.includes('<div id="charts">'));
    assert.ok(!html.includes('<div id="pages-table">'));
  });

  void it('custom --checks filters findings in markdown and HTML', () => {
    const md = renderMd('custom', { checks: ['performance'] });
    assert.doesNotMatch(md, /^## SEO Audit$/m);
    const full = renderMd('seo');
    assert.match(full, /^## SEO Audit$/m);
  });

  void it('custom --sections renders exactly the selection', () => {
    const md = renderMd('custom', { sections: ['seo'] });
    assert.match(md, /^## SEO Audit$/m);
    assert.doesNotMatch(md, /^## Performance Audit$/m);
    const html = renderHtml('custom', { sections: ['pages', 'executive-summary'] });
    assert.ok(html.indexOf('<div id="pages-table">') < html.indexOf('<div id="executive-summary">'));
    assert.ok(!html.includes('<div id="issues-detail">'));
  });

  void it('verified render honours the persisted selection; old state files render the full report', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-state-'));
    fs.writeFileSync(
      path.join(dir, 'phase2-state.json'),
      JSON.stringify({
        version: 1,
        suppressed: [],
        narratives: {},
        anomalies: [],
        noScore: false,
        checks: ['performance'],
      }),
    );
    const state = loadPhase2State(dir);
    assert.deepEqual(state?.checks, ['performance']);
    const filtered = preparedDetails(fixtureArtifacts(), new Set(), state?.checks);
    const all = preparedDetails(fixtureArtifacts(), new Set(), undefined);
    assert.ok(Object.keys(filtered).length < Object.keys(all).length);
    fs.writeFileSync(
      path.join(dir, 'phase2-state.json'),
      JSON.stringify({ version: 1, suppressed: [], narratives: {}, anomalies: [], noScore: false }),
    );
    const old = loadPhase2State(dir);
    assert.equal(old?.sections, undefined);
    assert.equal(old?.checks, undefined);
  });
});

void describe('visual family', () => {
  const visualMessages = [
    'Broken images detected',
    'Failed image or media requests',
    'Images upscaled beyond natural resolution',
    'CSS background images upscaled beyond natural resolution',
    'Unrendered template tokens in page text',
    'Placeholder text (lorem ipsum) on page',
    'Garbled characters (mojibake) in page text',
    'Text clipped by its container',
  ];
  const otherMessages = [
    'Some images load smaller srcset candidates than display target',
    'Some images download larger srcset candidates than they need',
    'Placeholder used instead of label',
    'Broken internal links',
  ];

  void it('is a valid --checks value and is in the seo and marketing presets only', () => {
    assert.deepEqual(resolvePreset('custom', { checks: ['visual'] }).checks, ['visual']);
    assert.equal(resolvePreset('seo').checks, undefined, 'seo keeps every check group, visual included');
    assert.ok(ROLE_DEFINITIONS.marketing.checks?.includes('visual'));
    assert.ok(!ROLE_DEFINITIONS.sales.checks?.includes('visual'));
  });

  void it('maps the visual messages to visual and leaves existing messages alone', () => {
    for (const m of visualMessages) assert.ok(findingCheckGroups(m, 'technical').includes('visual'), m);
    for (const m of otherMessages) assert.ok(!findingCheckGroups(m, 'technical').includes('visual'), m);
  });
});

void describe('agentic family', () => {
  const agenticMessages = [
    'Interactive elements without an accessible name',
    'Unlabeled click targets without an interactive role',
    'Form inputs without a label',
    'Content reachable only via hover or JavaScript',
    'llms.txt is missing',
    'llms.txt is invalid',
  ];

  void it('is a valid --checks value, in marketing and seo but not sales', () => {
    assert.deepEqual(resolvePreset('custom', { checks: ['agentic'] }).checks, ['agentic']);
    assert.equal(resolvePreset('seo').checks, undefined);
    assert.ok(ROLE_DEFINITIONS.marketing.checks?.includes('agentic'));
    assert.ok(!ROLE_DEFINITIONS.sales.checks?.includes('agentic'));
  });

  void it('maps the agentic messages to agentic and leaves others alone', () => {
    for (const m of agenticMessages) assert.ok(findingCheckGroups(m, 'technical').includes('agentic'), m);
    for (const m of ['Broken internal links', 'Missing meta description', 'Placeholder used instead of label'])
      assert.ok(!findingCheckGroups(m, 'technical').includes('agentic'), m);
  });
});
