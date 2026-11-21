import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateHTML, type HtmlReportSelection } from '../generateHTML';
import { renderPanel, findingChips, renderFindingList } from '../lib/reports/sections/report-panel';
import { getIssueTableCounts } from '../lib/reports/sections/issues-detail';
import { manyIssuesDetails, writeManyIssuesAudit } from '../scripts/preview-many-issues';
import { renderNoPresetHtml } from './fixtures/report-fixture/make-golden';

function renderHtml(auditFile: string, selection: HtmlReportSelection = {}): string {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'panels-')), 'index.html');
  generateHTML(auditFile, 'fixture.example', out, undefined, selection);
  return fs.readFileSync(out, 'utf8');
}

/** The `<summary>` header of one panel. */
function panelHeader(html: string, id: string): string {
  const start = html.indexOf(`id="panel-${id}"`);
  assert.ok(start >= 0, `panel ${id} rendered`);
  return html.slice(start, html.indexOf('</summary>', start));
}

void describe('report panels', () => {
  void it('renderPanel escapes the header, hides the section heading and sets the open state', () => {
    const html = renderPanel({
      id: 'x',
      title: 'A & B',
      meta: '<1 issue>',
      open: true,
      body: '<div><h2 style="color:red">A & B</h2><h2>Second</h2></div>',
    });
    assert.match(html, /<details class="report-panel" id="panel-x" data-panel="x" open>/);
    assert.ok(html.includes('A &amp; B</span>'));
    assert.ok(html.includes('&lt;1 issue&gt;'));
    assert.ok(html.includes('<h2 data-panel-heading style="color:red">'));
    assert.ok(html.includes('<h2>Second</h2>'), 'only the first heading is hidden');
    assert.doesNotMatch(renderPanel({ id: 'y', title: 'T', body: '' }), / open>/);
  });

  void it('finding chips count by severity, or say there are no issues', () => {
    const chips = findingChips([
      ['a', { severity: 'high' }],
      ['b', { severity: 'HIGH' }],
      ['c', { severity: 'low' }],
    ]);
    assert.ok(chips.includes('2 high') && chips.includes('1 low'));
    assert.ok(!chips.includes('critical'));
    assert.match(findingChips([]), /No issues/);
    assert.match(
      renderFindingList('x', [['<b>', { severity: 'medium', count: 3 }]]),
      /sev-chip--medium">medium<\/span><span class="finding-message">&lt;b&gt;<\/span>.*>3</,
    );
  });

  void it('a finding with examples opens to show its pages, with page text escaped', () => {
    const html = renderFindingList('x', [
      [
        'Form inputs without a label',
        {
          severity: 'high',
          count: 2,
          examples: ['1 input — <a href="https://example.com/a">https://example.com/a</a>', '<img src=x onerror=1>'],
        },
      ],
    ]);
    assert.match(html, /<details class="finding-details"><summary class="finding-row">/);
    assert.match(html, /<a href="https:\/\/example\.com\/a" target="_blank"[^>]*>https:\/\/example\.com\/a<\/a>/);
    assert.ok(!html.includes('<img'), 'page text in an example must stay escaped');
    assert.ok(!renderFindingList('x', [['m', { severity: 'low', count: 1 }]]).includes('<details'));
  });

  void it('opens only the summary and issues; every other section is folded with a summary line', () => {
    const html = renderNoPresetHtml();
    const opened = [...html.matchAll(/<details class="report-panel" id="panel-([\w-]+)"[^>]*\bopen>/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(opened, ['executive-summary', 'issues-detail']);
    for (const id of ['charts', 'technology-stack', 'configuration', 'pages-table']) {
      assert.match(panelHeader(html, id), /class="report-panel__meta"/, `${id} has a summary line`);
    }
  });

  void it('the Issues header counts match the Issues table rows', () => {
    const html = renderHtml(writeManyIssuesAudit());
    const header = panelHeader(html, 'issues-detail');
    assert.ok(header.includes('15 issue types'), header);
    assert.ok(header.includes('12 critical') && header.includes('3 low'));
    const counts = getIssueTableCounts({ analysis: { details: manyIssuesDetails() } });
    assert.deepEqual(counts, { total: 15, critical: 12, high: 0, medium: 0, low: 3 });
  });

  void it('an audit without performance data has no Performance section and no tab', () => {
    const html = renderNoPresetHtml();
    assert.doesNotMatch(html, /id="panel-performance"/);
    assert.doesNotMatch(html, /data-target="performance"/);
  });

  void it('section tabs follow the body order, with the crawl setup just before the pages', () => {
    const html = renderNoPresetHtml();
    const tabs = [...html.matchAll(/class="section-tab[^"]*" href="#([\w-]+)"/g)].map((m) => m[1]);
    assert.equal(tabs[0], 'executive-summary');
    assert.deepEqual(tabs.slice(-2), ['configuration', 'pages-table']);
    const bodyOrder = tabs.map((id) => html.indexOf(`id="panel-${id}"`));
    assert.deepEqual(
      [...bodyOrder].sort((a, b) => a - b),
      bodyOrder,
    );
  });
});
