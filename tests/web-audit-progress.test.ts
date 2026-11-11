import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ProgressReporter } from '../lib/utils/progress-reporter';
import {
  STALL_THRESHOLD_MS,
  computeEta,
  findMainReport,
  readRunParam,
  runViewState,
} from '../web/lib/audit-progress';

const OPTIONS = {
  url: 'https://example.com',
  preset: 'sales',
  sections: [],
  perf: false,
  llm: false,
  verify: false,
  contentResearch: false,
  concurrency: 5,
  evidenceCap: 10,
};
const START = Date.parse('2026-11-11T10:00:00Z');
const MIN = 60_000;

void describe('computeEta', () => {
  void it('estimates from total pages before any page finishes', () => {
    const small = computeEta({ processed: 0, total: 10 }, START, START, OPTIONS);
    const big = computeEta({ processed: 0, total: 1000 }, START, START, OPTIONS);
    assert.ok(small.remainingMinutes !== null && big.remainingMinutes !== null);
    assert.ok(big.remainingMinutes > small.remainingMinutes);
  });

  void it('extrapolates from elapsed time once pages are processed', () => {
    const eta = computeEta({ processed: 40, total: 120 }, START, START + 4 * MIN, OPTIONS);
    assert.equal(eta.remainingMinutes, 8);
    assert.equal(eta.percent, 33);
  });

  void it('recomputes from a grown total and clamps processed > total', () => {
    const before = computeEta({ processed: 40, total: 120 }, START, START + 4 * MIN, OPTIONS);
    const after = computeEta({ processed: 40, total: 300, phase: 'discovered' }, START, START + 4 * MIN, OPTIONS);
    assert.ok(after.remainingMinutes! > before.remainingMinutes!);
    assert.equal(after.phaseLabel, 'discovering links');
    const over = computeEta({ processed: 150, total: 120 }, START, START + MIN, OPTIONS);
    assert.equal(over.processed, 120);
    assert.equal(over.percent, 100);
  });
});

void describe('runViewState', () => {
  const now = START + 5 * MIN;
  void it('maps waiting/running/done/failed', () => {
    assert.equal(runViewState(404, START, now), 'waiting');
    assert.equal(runViewState({ status: 'running', startedAt: new Date(START).toISOString() }, START, now), 'running');
    assert.equal(runViewState({ status: 'succeeded', files: [{ name: 'focusreactive.com.html' }] }, START, now), 'succeeded');
    assert.equal(runViewState({ status: 'failed', error: 'x' }, START, now), 'failed');
    assert.equal(runViewState({ status: 'cancelled' }, START, now), 'failed');
  });

  void it('falls back when no main report exists', () => {
    assert.equal(runViewState({ status: 'succeeded', files: [{ name: 'audit-report.pdf' }] }, START, now), 'succeeded-no-report');
    assert.equal(findMainReport([{ name: 'audit-report.html' }]), null);
    assert.equal(findMainReport([{ name: 'audit-report.verified.html' }, { name: 'example.com.html' }])?.name, 'example.com.html');
    assert.equal(findMainReport([{ name: 'focusreactive.com.html' }])?.name, 'focusreactive.com.html');
  });

  void it('detects stalled runs', () => {
    assert.equal(runViewState(404, START, START + 11 * MIN), 'stalled');
    const stale = new Date(START).toISOString();
    assert.equal(
      runViewState({ status: 'running', startedAt: stale, progress: { processed: 1, total: 2, updatedAt: stale } }, START, START + STALL_THRESHOLD_MS + 1),
      'stalled',
    );
    const fresh = new Date(START + 10 * MIN).toISOString();
    assert.equal(
      runViewState({ status: 'running', startedAt: stale, progress: { processed: 1, total: 2, updatedAt: fresh } }, START, START + 11 * MIN),
      'running',
    );
  });
});

void describe('readRunParam', () => {
  void it('reads ?run=', () => {
    assert.equal(readRunParam('?run=20261111-101735-lbn6qa'), '20261111-101735-lbn6qa');
    assert.equal(readRunParam(''), null);
  });
});

void describe('ProgressReporter progress file', () => {
  void it('writes {processed,total,phase,updatedAt} when AUDIT_PROGRESS_FILE is set', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'progress-')), 'progress.json');
    const prev = process.env.AUDIT_PROGRESS_FILE;
    process.env.AUDIT_PROGRESS_FILE = file;
    try {
      const reporter = new ProgressReporter(120, 2000, 0, 'discovered', true);
      reporter.success('https://example.com/', 10);
      reporter.updateTotal(300);
      reporter.printSummary();
      assert.ok(existsSync(file));
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(doc.processed, 1);
      assert.equal(doc.total, 300);
      assert.equal(doc.phase, 'discovered');
      assert.ok(!Number.isNaN(Date.parse(doc.updatedAt)));
    } finally {
      if (prev === undefined) delete process.env.AUDIT_PROGRESS_FILE;
      else process.env.AUDIT_PROGRESS_FILE = prev;
    }
  });
});
