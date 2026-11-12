import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'node-html-parser';
import {
  checkFormLabels,
  checkHoverOnly,
  checkInteractiveNames,
  checkInteractiveRoles,
  llmsTxtFinding,
  runAgenticChecks,
  type ComputedHints,
} from '../lib/analyzers/agentic/agentic-checks';
import { AgenticBrowsingAnalyzer } from '../lib/analyzers/agentic/agentic-browsing-analyzer';
import { validateLlmsTxt } from '../lib/analyzers/seo/aeo-analyzer';
import { AGENTIC_FINDING_MESSAGES, SEVERITY } from '../lib/constants';
import type { ChromePage } from '../lib/types';

const dir = join(__dirname, 'fixtures', 'agentic');
const html = (name: string) => readFileSync(join(dir, `${name}.html`), 'utf8');
const doc = (name: string) => parse(html(name));
const hints = (name: string) => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as ComputedHints;

void describe('agentic checks', () => {
  void it('interactive names: passes named controls, flags nameless ones', () => {
    assert.strictEqual(checkInteractiveNames(doc('names-pass')).passed, true);
    const fail = checkInteractiveNames(doc('names-fail'));
    assert.deepStrictEqual(fail.offenders, ['<a>', '<button>', '<div>']);
  });

  void it('interactive roles: passes native/role+tabindex targets, flags a bare onclick div', () => {
    assert.strictEqual(checkInteractiveRoles(doc('roles-pass')).passed, true);
    assert.deepStrictEqual(checkInteractiveRoles(doc('roles-fail')).offenders, ['<div.card>']);
  });

  void it('interactive roles: uses computed cursor:pointer hints', () => {
    assert.strictEqual(checkInteractiveRoles(doc('roles-pass'), hints('hints-pass')).passed, true);
    assert.deepStrictEqual(checkInteractiveRoles(doc('roles-pass'), hints('hints-fail')).offenders, ['<div.tile>']);
  });

  void it('form labels: passes labelled inputs, flags unlabelled ones', () => {
    assert.strictEqual(checkFormLabels(doc('labels-pass')).passed, true);
    assert.deepStrictEqual(checkFormLabels(doc('labels-fail')).offenders, ['<input#q>', '<select>']);
  });

  void it('hover-only: inline styles with a focus counterpart pass; hover-only reveal and javascript: links fail', () => {
    assert.strictEqual(checkHoverOnly(doc('hover-pass')).passed, true);
    assert.deepStrictEqual(checkHoverOnly(doc('hover-fail')).offenders, ['.menu:hover ul', '<a>']);
  });

  void it('hover-only: computed hints replace the inline-style fallback', () => {
    assert.strictEqual(
      checkHoverOnly(doc('hover-fail'), hints('hints-pass')).offenders.includes('.menu:hover ul'),
      false,
    );
    assert.ok(checkHoverOnly(doc('hover-pass'), hints('hints-fail')).offenders.includes('.mega:hover .panel'));
  });

  void it('runAgenticChecks emits one finding per failed check with SEVERITY values', () => {
    const page = runAgenticChecks(html('names-fail') + html('labels-fail'), hints('hints-pass'));
    assert.deepStrictEqual(
      page.issues.map((i) => i.message),
      [AGENTIC_FINDING_MESSAGES.interactiveNames.message, AGENTIC_FINDING_MESSAGES.formLabels.message],
    );
    assert.ok(page.issues.every((i) => Object.values(SEVERITY).includes(i.severity)));
    assert.strictEqual(page.computedHintsUnavailable, undefined);
  });

  void it('marks pages without computed hints and still runs HTML-only rules', () => {
    const page = runAgenticChecks(html('hover-fail'));
    assert.strictEqual(page.computedHintsUnavailable, true);
    assert.strictEqual(page.checks.hoverOnly.passed, false);
    assert.strictEqual(page.checks.interactiveRoles.passed, true);
  });

  void it('analyzer falls back to HTML-only when the in-page evaluate fails', async () => {
    const page = { evaluate: () => Promise.reject(new Error('detached')) } as unknown as ChromePage;
    const data = await AgenticBrowsingAnalyzer.analyze(page, 'https://x.test/', html('names-pass'));
    assert.strictEqual(data.computedHintsUnavailable, true);
    assert.strictEqual(data.issues.length, 0);
  });
});

void describe('llms.txt adapter', () => {
  void it('validates title and Markdown links; bare URLs do not count', () => {
    assert.strictEqual(validateLlmsTxt('# Site\n\n- [Docs](https://x.test/docs)\n').status, 'valid');
    const bare = validateLlmsTxt('# Site\n\nhttps://x.test/docs\n');
    assert.deepStrictEqual(bare.problems, ['no Markdown links']);
    assert.deepStrictEqual(validateLlmsTxt('- [Docs](/docs)').problems, ['no # title heading']);
  });

  void it('maps status to one site-level finding at origin/llms.txt', () => {
    assert.strictEqual(llmsTxtFinding({ hasLlmsTxt: true, status: 'valid' }, 'https://x.test'), null);
    assert.deepStrictEqual(llmsTxtFinding({ hasLlmsTxt: false, status: 'missing' }, 'https://x.test/'), {
      ...AGENTIC_FINDING_MESSAGES.llmsTxtMissing,
      detail: 'https://x.test/llms.txt',
    });
    assert.strictEqual(
      llmsTxtFinding({ hasLlmsTxt: true, status: 'invalid' }, 'https://x.test')?.severity,
      SEVERITY.MEDIUM,
    );
    // 5xx / unreachable: the file was never read, so neither "missing" nor "invalid" is proven.
    assert.strictEqual(llmsTxtFinding({ hasLlmsTxt: false, status: 'server-error' }, 'https://x.test'), null);
    assert.strictEqual(llmsTxtFinding(undefined, 'https://x.test'), null);
  });
});
