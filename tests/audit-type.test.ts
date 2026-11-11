import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { auditTypeLabel, PRESET_NAMES } from '../lib/presets';
import { loadPhase2State } from '../lib/phase3/verify-runner';
import { renderNoPresetHtml, renderNoPresetMarkdown } from './fixtures/report-fixture/make-golden';

const EXPECTED: Record<string, string> = {
  quick: 'Quick',
  standard: 'Standard',
  deep: 'Deep',
  sales: 'Sales',
  marketing: 'Marketing',
  seo: 'SEO',
  custom: 'Custom',
};

function headerOf(html: string): string {
  const match = html.match(/<header>([\s\S]*?)<\/header>/);
  assert.ok(match, 'report has a <header>');
  return match[1];
}

void describe('audit type', () => {
  void it('labels every preset, and no preset as "Full audit"', () => {
    for (const name of PRESET_NAMES) assert.equal(auditTypeLabel(name), EXPECTED[name]);
    assert.equal(auditTypeLabel(undefined), 'Full audit');
    assert.equal(auditTypeLabel('bogus'), 'Full audit');
  });

  void it('HTML report header names the audit type and the generic title has no "SEO"', () => {
    for (const preset of [...PRESET_NAMES, undefined]) {
      const html = renderNoPresetHtml({ preset });
      assert.match(headerOf(html), new RegExp(`Audit type: ${auditTypeLabel(preset)}`));
      const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
      assert.equal(title.includes('SEO'), false, title);
      const h1 = headerOf(html).match(/<h1>([^<]*)<\/h1>/)?.[1] ?? '';
      assert.match(h1, /Audit report/);
      assert.equal(h1.includes('SEO'), false, h1);
    }
  });

  void it('Phase 2 markdown states the audit type near the top', () => {
    for (const preset of [...PRESET_NAMES, undefined]) {
      const top = renderNoPresetMarkdown({ preset }).split('\n').slice(0, 5).join('\n');
      assert.match(top, new RegExp(`\\*\\*Audit type:\\*\\* ${auditTypeLabel(preset)}`));
      assert.equal(top.includes('SEO Audit Report'), false);
    }
  });

  void it('Phase 3 verified report re-renders the audit type persisted in phase2-state.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-type-'));
    const state = { version: 1, generatedAt: '', suppressed: [], narratives: {}, anomalies: [], noScore: false, preset: 'marketing' };
    fs.writeFileSync(path.join(dir, 'phase2-state.json'), JSON.stringify(state));
    const persisted = loadPhase2State(dir);
    assert.equal(persisted?.preset, 'marketing');
    assert.match(renderNoPresetMarkdown({ preset: persisted?.preset }), /\*\*Audit type:\*\* Marketing/);
  });
});
