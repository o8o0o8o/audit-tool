import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { generateHTML } from '../generateHTML';
import { getDesignTokens } from '../lib/reports/sections/design-tokens';

const fixture = path.join(__dirname, 'fixtures', 'report-fixture', 'audit.json');

void describe('HTML report — FocusReactive brand theme', () => {
  let tmpDir: string;
  let html: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-brand-'));
    const out = path.join(tmpDir, 'report.html');
    generateHTML(fixture, 'fixture.example', out);
    html = fs.readFileSync(out, 'utf8');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('defines the brand palette and Inter font tokens', () => {
    const tokens = getDesignTokens();
    assert.match(tokens, /--color-bg-page:\s*var\(--fr-black\)/);
    assert.match(tokens, /--fr-black:\s*#000000/);
    assert.match(tokens, /--fr-accent:\s*#00E56D/i);
    assert.match(tokens, /--font-family-sans:\s*'Inter', Helvetica, sans-serif/);
  });

  void it('loads Inter and renders the wordmark header and branded footer', () => {
    assert.match(html, /fonts\.googleapis\.com\/css2\?family=Inter/);
    assert.match(html, /<header>[\s\S]*class="fr-wordmark"[^>]*>Focus Reactive/);
    assert.match(html, /<footer>[\s\S]*fr-footer-inner/);
  });

  void it('keeps every report section, folded into panels with only summary and issues open', () => {
    for (const id of [
      'executive-summary',
      'issues-detail',
      'performance',
      'charts',
      'technology-stack',
      'content-insights',
      'pages-table',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `missing section #${id}`);
    }
    assert.match(html, /<details class="report-panel" id="panel-executive-summary" data-panel="executive-summary" open>/);
    assert.match(html, /<details class="report-panel" id="panel-issues-detail" data-panel="issues-detail" open>/);
    assert.match(html, /<details class="report-panel" id="panel-pages-table" data-panel="pages-table">/);
    assert.match(html, /<details class="report-panel" id="panel-charts" data-panel="charts">/);
    assert.ok(html.includes('window.revealInReport'), 'tabs and links unfold the panel they point into');
    assert.ok(!html.includes('class="report-nav"'), 'no duplicate sidebar navigation');
    assert.ok(html.includes('<canvas id="issueChart">'));
  });

  void it('prints black on white with buttons hidden', () => {
    const print = html.slice(html.indexOf('@media print'));
    assert.match(print, /body\s*\{\s*background:\s*#fff !important;\s*color:\s*#000 !important;/);
    assert.match(print, /\.fr-btn,/);
  });

  void it('comparison report has no literal white card backgrounds', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'generateComparison.ts'), 'utf8');
    assert.doesNotMatch(src, /background:\s*white/);
    assert.match(src, /@media print/);
  });
});
