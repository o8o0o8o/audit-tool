import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'node-html-parser';
import { parseArgs, agenticChildArgs } from '../lib/args-parser';
import { resolveAgentic, batchSiteOptions } from '../lib/config-loader';
import { runAnalyzers } from '../lib/crawler/analyzer-runner';
import { AgenticBrowsingAnalyzer } from '../lib/analyzers/agentic/agentic-browsing-analyzer';
import { AuditOrchestrator } from '../lib/orchestrators/audit-orchestrator';
import { resolveResumeAgentic } from '../lib/seo-data';
import { SEVERITY } from '../lib/constants';
import type { ChromePage, PageInfo } from '../lib/types';
import type { CrawlerInternalOptions } from '../lib/crawler/crawler-types';

const URL_UNDER_TEST = 'https://example.com/page';
const FAILING_HTML = `<html><body>
  <button></button>
  <form><input type="text" name="q"></form>
  <a href="javascript:void(0)">Menu</a>
</body></html>`;
const HINTS = { pointerSelectors: ['<div.card>'], hoverOnlySelectors: [] };

// Every page method rejects at once, so the other analyzers settle immediately with their fallbacks.
function rejected(): Promise<never> {
  const promise = Promise.reject(new Error('no browser in unit tests'));
  promise.catch(() => undefined);
  return promise;
}

const chromePage = new Proxy(
  {},
  { get: (_t, prop) => (prop === 'then' ? undefined : rejected) },
) as unknown as ChromePage;

type Reported = { message: string; detail: string; severity?: string };

async function run(agentic?: boolean) {
  const reported: Reported[] = [];
  const pageData = { url: URL_UNDER_TEST } as PageInfo;
  const args: Parameters<typeof runAnalyzers> = [
    chromePage,
    parse(FAILING_HTML) as never,
    URL_UNDER_TEST,
    pageData,
    FAILING_HTML,
    {},
    null,
    { verbose: false } as CrawlerInternalOptions,
    (message, detail, severity) => reported.push({ message, detail, severity }),
    undefined,
    false,
  ];
  if (agentic !== undefined) args.push(agentic);
  await runAnalyzers(...args);
  return { reported, pageData: pageData as PageInfo & { agentic?: unknown } };
}

const severities = new Set<string>(Object.values(SEVERITY));

void describe('agentic flag parsing', () => {
  void it('defaults to null (config decides) and honours --agentic / --no-agentic', () => {
    assert.equal(parseArgs([]).agentic, null);
    assert.equal(parseArgs(['--agentic']).agentic, true);
    assert.equal(parseArgs(['--no-agentic']).agentic, false);
  });

  void it('is on by default, .seoauditrc can turn it off, the CLI flag wins', () => {
    assert.equal(resolveAgentic(null, {}), true);
    assert.equal(resolveAgentic(null, { agentic: false }), false);
    assert.equal(resolveAgentic(true, { agentic: false }), true);
    assert.equal(resolveAgentic(false, {}), false);
    assert.equal(batchSiteOptions({ agentic: null }, {}).agentic, true);
    assert.equal(batchSiteOptions({ agentic: false }, {}).agentic, false);
  });

  void it('carries an explicit choice across a restart', () => {
    assert.deepEqual(agenticChildArgs(null), []);
    assert.deepEqual(agenticChildArgs(true), ['--agentic']);
    assert.deepEqual(agenticChildArgs(false), ['--no-agentic']);
  });

  void it('keeps the checkpoint pages’ setting on resume', () => {
    assert.equal(resolveResumeAgentic(false, {}), false);
    assert.equal(resolveResumeAgentic(false, { a: { url: 'a', agentic: { checks: {} } } }), true);
    assert.equal(resolveResumeAgentic(true, { a: { url: 'a' } }), false);
  });
});

void describe('analyzer runner', () => {
  afterEach(() => mock.restoreAll());

  void it('runs the agentic analyzer by default, with all four per-page checks registered', async () => {
    const spy = mock.method(AgenticBrowsingAnalyzer, 'analyze');
    const { pageData } = await run();
    assert.equal(spy.mock.callCount(), 1);
    const data = pageData.agentic as { checks: Record<string, unknown> };
    assert.deepEqual(Object.keys(data.checks).sort(), [
      'formLabels',
      'hoverOnly',
      'interactiveNames',
      'interactiveRoles',
    ]);
  });

  void it('skips the agentic analyzer under --no-agentic', async () => {
    const spy = mock.method(AgenticBrowsingAnalyzer, 'analyze');
    const { reported, pageData } = await run(false);
    assert.equal(spy.mock.callCount(), 0);
    assert.equal(pageData.agentic, undefined);
    assert.ok(!reported.some((r) => /accessible name|without a label/.test(r.message)));
  });

  void it('reports each failed check with a SEVERITY value and the page URL, serialised with the page', async () => {
    mock.method(AgenticBrowsingAnalyzer, 'analyze', async (_p: ChromePage, _u: string, html: string) => {
      const { runAgenticChecks } = await import('../lib/analyzers/agentic/agentic-checks');
      return runAgenticChecks(html, HINTS);
    });
    const { reported, pageData } = await run(true);
    const expected = [
      'Interactive elements without an accessible name',
      'Unlabeled click targets without an interactive role',
      'Form inputs without a label',
      'Content reachable only via hover or JavaScript',
    ];
    for (const message of expected) {
      const finding = reported.find((r) => r.message === message);
      assert.ok(finding, `missing finding: ${message}`);
      assert.ok(severities.has(finding.severity ?? ''), `${message}: severity ${finding.severity}`);
      assert.ok(finding.detail.includes(URL_UNDER_TEST), `${message}: no page URL in ${finding.detail}`);
    }
    const serialised = JSON.parse(JSON.stringify(pageData)) as {
      agentic: { checks: Record<string, { passed: boolean }> };
    };
    assert.equal(serialised.agentic.checks.formLabels.passed, false);
  });
});

void describe('site-level llms.txt finding', () => {
  const collect = (info: Parameters<typeof AuditOrchestrator.reportLlmsTxtFinding>[0]) => {
    const out: Reported[] = [];
    AuditOrchestrator.reportLlmsTxtFinding(info, 'https://example.com/', (message, detail, severity) =>
      out.push({ message, detail: detail ?? '', severity }),
    );
    return out;
  };

  void it('reports a missing llms.txt once, at origin/llms.txt, with a SEVERITY value', () => {
    const out = collect({ hasLlmsTxt: false, status: 'missing' });
    assert.equal(out.length, 1);
    assert.equal(out[0].detail, 'https://example.com/llms.txt');
    assert.ok(severities.has(out[0].severity ?? ''));
  });

  void it('reports an invalid llms.txt and stays quiet for a valid one', () => {
    assert.equal(collect({ hasLlmsTxt: true, status: 'invalid' })[0].message, 'llms.txt is invalid');
    assert.equal(collect({ hasLlmsTxt: true, status: 'valid' }).length, 0);
  });
});
