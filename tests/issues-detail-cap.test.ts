import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { generateHTML, type HtmlReportSelection } from '../generateHTML';
import { getIssuesDetail } from '../lib/reports/sections/issues-detail';
import { getHistoricalProgress } from '../lib/reports/sections/historical-progress';
import type { ComparisonData, ReportSectionData } from '../lib/types';
import { manyIssuesDetails, writeManyIssuesAudit } from '../scripts/preview-many-issues';
import { renderNoPresetHtml } from './fixtures/report-fixture/make-golden';

function sectionData(details: Record<string, unknown>, comparison?: ComparisonData): ReportSectionData {
  return {
    jsonData: { analysis: { details } },
    pages: [],
    pageData: {} as ReportSectionData['pageData'],
    comparison,
  };
}

function comparisonOf(details: Record<string, unknown>): ComparisonData {
  return {
    compareJsonData: { analysis: { details } },
    comparePages: [],
    comparePageData: {} as ComparisonData['comparePageData'],
    compareDomainName: 'b.example',
    originDomainName: 'a.example',
    matchedPaths: [],
    originOnlyPaths: [],
    compareOnlyPaths: [],
  };
}

const parentRows = (html: string) => html.match(/<tr class="issues-table-row"[^>]*>/g) ?? [];
const detailRows = (html: string) => html.match(/<tr class="issue-detail-row"[^>]*>/g) ?? [];
const isOverflow = (tag: string) => tag.includes('data-overflow="1"');

function assertCapped(html: string) {
  const parents = parentRows(html);
  const details = detailRows(html);
  assert.equal(parents.length, 15);
  assert.equal(parents.filter((r) => !isOverflow(r)).length, 10);
  assert.equal(parents.filter(isOverflow).length, 5);
  parents.forEach((p, i) => assert.equal(isOverflow(details[i]), isOverflow(p), `detail row ${i} follows its parent`));
  parents.filter(isOverflow).forEach((p) => assert.match(p, /display:none/));
  // Sorted severity-first: the overflow holds the 2 lowest critical issues and all 3 low ones.
  assert.deepEqual(
    parents.filter(isOverflow).map((p) => /data-severity="(\w+)"/.exec(p)?.[1]),
    ['critical', 'critical', 'low', 'low', 'low'],
  );
  assert.match(html, /class="issues-show-all[^"]*"[^>]*>Show all \(15\)<\/button>/);
  assert.match(html, /@media print[\s\S]*data-overflow="1"\][^}]*display: table-row !important/);
}

type FakeEl = {
  dataset: Record<string, string>;
  style: { display: string };
  textContent: string;
  classList: { contains(c: string): boolean; add(c: string): void; remove(c: string): void };
  nextElementSibling: FakeEl | null;
  querySelector(sel: string): FakeEl | null;
  closest(sel: string): FakeEl;
};

function fakeEl(tag: string, section?: () => FakeEl): FakeEl {
  const dataset: Record<string, string> = {};
  for (const m of tag.matchAll(/data-([\w-]+)="([^"]*)"/g)) dataset[m[1]] = m[2];
  const classes = new Set((/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/).filter(Boolean));
  const display = /style="[^"]*display:\s*none/.test(tag) ? 'none' : '';
  const chevron = { textContent: '' } as FakeEl;
  return {
    dataset,
    style: { display },
    textContent: '',
    classList: { contains: (c) => classes.has(c), add: (c) => void classes.add(c), remove: (c) => void classes.delete(c) },
    nextElementSibling: null,
    querySelector: (sel) => (sel === '.row-chevron' ? chevron : null),
    closest: () => section!(),
  };
}

/** Executes the report's inline issue-table script against a fake DOM made from the rendered markup. */
function runIssueScript(html: string) {
  const script = /<script>([\s\S]*?function applyIssueRows[\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'issue table script rendered');
  const holder: { section?: FakeEl } = {};
  const getSection = () => holder.section!;
  const rowTags = html.match(/<tr class="(?:issues-table-row|issue-detail-row)"[^>]*>/g) ?? [];
  const all = rowTags.map((t) => fakeEl(t, getSection));
  all.forEach((el, i) => (el.nextElementSibling = all[i + 1] ?? null));
  const rows = all.filter((el) => el.classList.contains('issues-table-row'));
  const pills = (html.match(/<button[^>]*class="[^"]*sev-pill[^"]*"[^>]*>/g) ?? [])
    .filter((t) => !t.includes('issues-show-all'))
    .map((t) => {
      const el = fakeEl(t, getSection);
      el.dataset.sevArg = /filterIssueSev\('(\w+)'/.exec(t)?.[1] ?? '';
      return el;
    });
  const moreTag = /<button[^>]*class="issues-show-all[^"]*"[^>]*>[^<]*<\/button>/.exec(html)?.[0];
  assert.ok(moreTag, 'Show all button rendered');
  const more = fakeEl(moreTag, getSection);
  more.textContent = />([^<]*)<\/button>$/.exec(moreTag)![1];
  holder.section = {
    ...fakeEl('<div class="issues-section">'),
    querySelectorAll: (sel: string) => (sel === '.issues-table-row' ? rows : sel === '.sev-pill' ? pills : []),
    querySelector: (sel: string) => (sel === '.issues-show-all' ? more : null),
  } as FakeEl;
  const ctx = vm.createContext({ document: { getElementById: () => null } }) as Record<string, (...a: unknown[]) => void> &
    vm.Context;
  vm.runInContext(script, ctx);
  const pill = (sev: string) => {
    const p = pills.find((x) => x.dataset.sevArg === sev);
    assert.ok(p, `pill ${sev} rendered`);
    return p;
  };
  return { ctx, rows, more, pill };
}

function renderHtml(auditFile: string, selection: HtmlReportSelection = {}): string {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-')), 'index.html');
  generateHTML(auditFile, 'fixture.example', out, undefined, selection);
  return fs.readFileSync(out, 'utf8');
}

void describe('issues table cap', () => {
  void it('main table shows 10 issues and a Show all (15) toggle', () => {
    assertCapped(getIssuesDetail(sectionData(manyIssuesDetails())));
  });

  void it('comparison table applies the same cap', () => {
    const details = manyIssuesDetails();
    assertCapped(getIssuesDetail(sectionData(details, comparisonOf(details))));
  });

  void it('exactly 10 issues renders no overflow and no toggle', () => {
    const html = getIssuesDetail(sectionData(manyIssuesDetails(8, 2)));
    assert.equal(parentRows(html).filter(isOverflow).length, 0);
    assert.doesNotMatch(html, /issues-show-all[^"]*"[^>]*>Show all/);
  });

  void it('runs the rendered toggle: show all, Critical pill, back to All', () => {
    const html = getIssuesDetail(sectionData(manyIssuesDetails()));
    const ui = runIssueScript(html);
    const visible = () => ui.rows.filter((r) => r.style.display !== 'none');
    const sevs = () => visible().map((r) => r.dataset.severity);

    assert.equal(visible().length, 10);
    assert.equal(ui.more.textContent, 'Show all (15)');

    ui.ctx.toggleIssuesShowAll(ui.more);
    assert.equal(visible().length, 15);
    assert.equal(ui.more.textContent, 'Show less');

    ui.ctx.toggleIssuesShowAll(ui.more);
    assert.equal(visible().length, 10);

    const criticalCount = ui.rows.filter((r) => r.dataset.severity === 'critical').length;
    ui.ctx.filterIssueSev('critical', ui.pill('critical'));
    assert.equal(visible().length, criticalCount, 'Critical pill shows every critical issue, overflow included');
    assert.ok(sevs().every((s) => s === 'critical'));
    assert.ok(visible().some((r) => r.dataset.overflow === '1'), 'an overflow critical row is shown');
    assert.equal(ui.more.style.display, 'none', 'toggle hidden under a specific severity');

    ui.ctx.filterIssueSev('all', ui.pill('all'));
    assert.equal(visible().length, 10, 'back to All re-applies the cap');
    assert.equal(ui.more.style.display, '');
    assert.equal(ui.more.textContent, 'Show all (15)');
  });
});

void describe('history section placement', () => {
  void it('first audit renders a single note, no cards or first-audit panel', () => {
    const html = getHistoricalProgress(sectionData({}));
    assert.equal(html, '<p class="history-note">Trends appear after your second audit.</p>');
    const report = renderNoPresetHtml();
    assert.doesNotMatch(report, /This is your first audit!/);
    assert.doesNotMatch(report, /Current Score/);
  });

  void it('no-preset order puts history after the issues and before the pages table', () => {
    const report = renderNoPresetHtml();
    const issues = report.indexOf('class="issues-section"');
    const history = report.indexOf('class="history-note"');
    const config = report.indexOf('class="info-section"');
    const pages = report.indexOf('<div id="pages-table">');
    assert.ok(issues >= 0 && history > issues, 'history after issues');
    assert.ok(config > history && pages > config, 'config info then pages table last');
  });

  void it('an order without the pages table puts config info last', () => {
    const report = renderHtml(writeManyIssuesAudit(), { sections: ['issues-detail', 'history'] });
    const history = report.indexOf('class="history-note"');
    const config = report.indexOf('class="info-section"');
    assert.ok(history >= 0 && config > history);
  });
});
