import { describe, it } from 'node:test';
import assert from 'node:assert';

import { isValidRunId, newRunId, parseAuditRequest, toCliArgs, toWorkflowInputs } from '../web/lib/audit-options';

void describe('web audit options', () => {
  void it('accepts a valid request and fills defaults', () => {
    const result = parseAuditRequest({ url: 'https://example.com/path' });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepStrictEqual(result.options, {
      url: 'https://example.com',
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
