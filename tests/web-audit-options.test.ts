import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ROLE_PRESETS, REPORT_SECTIONS } from '../lib/presets';
import {
  WEB_PRESETS,
  WEB_REPORT_SECTIONS,
  isValidRunId,
  newRunId,
  parseAuditRequest,
  toCliArgs,
  toWorkflowInputs,
} from '../web/lib/audit-options';

void describe('web audit options', () => {
  void it('accepts a valid request and fills defaults', () => {
    const result = parseAuditRequest({ url: 'https://example.com/path' });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepStrictEqual(result.options, {
      url: 'https://example.com',
      preset: null,
      sections: [],
      perf: false,
      llm: false,
      verify: false,
      contentResearch: false,
      concurrency: 5,
      limit: null,
      evidenceCap: 10,
    });
  });

  for (const url of ['javascript:alert(1)', 'ftp://example.com', 'http://localhost', 'http://192.168.1.1', 'not a url', '']) {
    void it(`rejects url ${JSON.stringify(url)}`, () => {
      const result = parseAuditRequest({ url });
      assert.strictEqual(result.ok, false);
    });
  }

  void it('rejects out-of-range concurrency and evidence cap', () => {
    for (const body of [
      { url: 'https://example.com', concurrency: 0 },
      { url: 'https://example.com', concurrency: 21 },
      { url: 'https://example.com', evidenceCap: 0 },
      { url: 'https://example.com', evidenceCap: 101 },
      { url: 'https://example.com', limit: -1 },
    ]) {
      assert.strictEqual(parseAuditRequest(body).ok, false, JSON.stringify(body));
    }
  });

  void it('maps toggles to workflow inputs and CLI args', () => {
    const result = parseAuditRequest({
      url: 'https://example.com',
      perf: true,
      llm: 'on',
      verify: true,
      contentResearch: true,
      concurrency: '3',
      limit: 5,
      evidenceCap: 20,
    });
    assert.ok(result.ok);
    if (!result.ok) return;
    const inputs = toWorkflowInputs(result.options, 'run-12345678');
    assert.deepStrictEqual(inputs, {
      url: 'https://example.com',
      run_id: 'run-12345678',
      preset: '',
      sections: '',
      perf: 'true',
      llm: 'true',
      verify: 'true',
      content_research: 'true',
      concurrency: '3',
      limit: '5',
      evidence_cap: '20',
    });
    assert.deepStrictEqual(toCliArgs(inputs), [
      '--origin=https://example.com',
      '--perf',
      '--llm',
      '--verify',
      '--content-research',
      '--concurrency=3',
      '--limit=5',
      '--evidence-cap=20',
    ]);
  });

  void it('keeps presets and sections in lockstep with lib/presets.ts', () => {
    assert.deepStrictEqual([...WEB_PRESETS], [...ROLE_PRESETS]);
    assert.deepStrictEqual([...WEB_REPORT_SECTIONS], [...REPORT_SECTIONS]);
  });

  void it('passes a role preset through and keeps option toggles', () => {
    const result = parseAuditRequest({ url: 'https://example.com', preset: 'sales', perf: true, llm: true });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.strictEqual(result.options.perf, true);
    assert.strictEqual(result.options.llm, true);
    const args = toCliArgs(toWorkflowInputs(result.options, 'run-12345678'));
    assert.deepStrictEqual(args.slice(0, 2), ['--origin=https://example.com', '--preset=sales']);
    assert.ok(!args.some((a) => a.startsWith('--sections=')));
    assert.ok(args.includes('--perf') && args.includes('--llm'));
  });

  void it('maps a custom preset with sections in canonical order', () => {
    const result = parseAuditRequest({ url: 'https://example.com', preset: 'custom', sections: ['seo', 'cta'], perf: 'on' });
    assert.ok(result.ok);
    if (!result.ok) return;
    const args = toCliArgs(toWorkflowInputs(result.options, 'run-12345678'));
    assert.deepStrictEqual(args.slice(0, 4), ['--origin=https://example.com', '--preset=custom', '--sections=cta,seo', '--perf']);
  });

  void it('rejects unknown presets, unknown sections and bad section combos', () => {
    for (const body of [
      { url: 'https://example.com', preset: 'bogus' },
      { url: 'https://example.com', preset: 'custom' },
      { url: 'https://example.com', preset: 'custom', sections: ['nope'] },
      { url: 'https://example.com', preset: 'seo', sections: ['seo'] },
    ]) {
      assert.strictEqual(parseAuditRequest(body).ok, false, JSON.stringify(body));
    }
    assert.ok(parseAuditRequest({ url: 'https://example.com', preset: 'full' }).ok);
  });

  void it('validates run ids', () => {
    assert.ok(isValidRunId(newRunId()));
    for (const bad of ['../x', 'a/b', '..', '', 'UPPERCASE-RUN', 'a'.repeat(65), 'short']) {
      assert.strictEqual(isValidRunId(bad), false, bad);
    }
  });

  void it('rejects private IPv6, CGNAT and IPv4-mapped hosts', () => {
    for (const url of ['http://[fd00::1]', 'http://[fe80::1]', 'http://[::ffff:127.0.0.1]', 'http://100.64.0.1', 'http://0.1.2.3']) {
      assert.strictEqual(parseAuditRequest({ url }).ok, false, url);
    }
    assert.strictEqual(parseAuditRequest({ url: 'http://[2606:4700::1111]' }).ok, true);
  });
});
