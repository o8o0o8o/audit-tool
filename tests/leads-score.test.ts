import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CompanyRecord } from '../lib/leads/csv-store';
import {
  DEFAULT_WEIGHTS,
  DEFAULT_WEIGHTS_PATH,
  formatReasons,
  loadWeights,
  rank,
  scoreCompany,
} from '../lib/leads/score';
import { MAX_SCAN_RETRIES, SELECTABLE_STAGES, STAGES, canMove, stageOf, stageValues } from '../lib/leads/stages';

const row = (values: Partial<CompanyRecord>): CompanyRecord =>
  ({
    company: 'Acme',
    website: 'acme.com',
    languages: '1',
    traffic: '0',
    fingerprinted_at: '2026-11-13T10:00:00.000Z',
    stack_kind: 'unknown',
    stack_confidence: 'low',
    cms_detected: '',
    cms_secondary: '',
    eol: '',
    stack_signals: '',
    ...values,
  }) as CompanyRecord;

void describe('lead score', () => {
  void it('the shipped weights file loads and matches the defaults in code', () => {
    assert.deepEqual(loadWeights(DEFAULT_WEIGHTS_PATH), DEFAULT_WEIGHTS);
    assert.equal(
      Object.values(DEFAULT_WEIGHTS.weights).reduce((a, b) => a + b, 0),
      100,
    );
  });

  void it('a legacy stack at high confidence with end-of-life software, traffic and languages', () => {
    const fit = scoreCompany(
      row({
        stack_kind: 'legacy',
        stack_confidence: 'high',
        cms_detected: 'Drupal',
        eol: 'Drupal 7 (ended 2025-01-05)',
        traffic: '1000000',
        languages: '3',
      }),
    );
    assert.equal(fit.score, 30 + 15 + 20 + 10);
    assert.equal(fit.track, 'migrate');
    assert.equal(fit.blocker, null);
    assert.deepEqual(fit.missing, ['job_keywords', 'blog_velocity']);
    assert.equal(formatReasons(fit), 'stack 30; eol 15; traffic 20; lang 10');
  });

  void it('low confidence, builder stacks and a PHP-only end-of-life hit earn a share', () => {
    assert.equal(scoreCompany(row({ stack_kind: 'legacy', stack_confidence: 'low' })).lines[0].points, 21);
    assert.equal(scoreCompany(row({ stack_kind: 'builder', stack_confidence: 'high' })).lines[0].points, 15);
    assert.equal(scoreCompany(row({ stack_kind: 'headless', stack_confidence: 'high' })).lines[0].points, 0);
    assert.equal(scoreCompany(row({ eol: 'PHP 7.4.33 (ended 2022-11-28)' })).lines[1].points, 7.5);
    assert.equal(
      scoreCompany(row({ eol: 'PHP 7.4.33 (ended 2022-11-28); Drupal 7 (ended 2025-01-05)' })).lines[1].points,
      15,
    );
  });

  void it('traffic is on a log scale between the floor and the ceiling', () => {
    const points = (traffic: string) => scoreCompany(row({ traffic })).lines[2].points;
    assert.equal(points('500'), 0);
    assert.equal(points('1000'), 0);
    assert.equal(points('31623'), 10); // halfway on a log scale between 1e3 and 1e6
    assert.equal(points('5000000'), 20);
    assert.equal(points(''), 0);
    assert.ok(scoreCompany(row({ traffic: '' })).missing.includes('traffic'));
  });

  void it('signal-sheet columns score once they exist', () => {
    const fit = scoreCompany(row({ job_keywords: 'yes', blog_velocity: '50%' }));
    assert.equal(fit.lines.find((l) => l.signal === 'jobKeywords')?.points, 15);
    assert.equal(fit.lines.find((l) => l.signal === 'blogVelocity')?.points, 5);
    assert.deepEqual(fit.missing, []);
  });

  void it('tracks follow the stack kind', () => {
    assert.equal(scoreCompany(row({ stack_kind: 'hybrid' })).track, 'migrate');
    assert.equal(scoreCompany(row({ stack_kind: 'builder' })).track, 'migrate');
    assert.equal(scoreCompany(row({ stack_kind: 'headless' })).track, 'optimise');
    assert.equal(scoreCompany(row({ stack_kind: 'custom' })).track, 'optimise');
    assert.equal(scoreCompany(row({ stack_kind: 'unreadable' })).track, null);
  });

  void it('names the reason a row must not be scanned', () => {
    assert.equal(scoreCompany(row({ fingerprinted_at: '' })).blocker, 'not fingerprinted yet');
    assert.equal(scoreCompany(row({ stack_kind: 'unreadable' })).blocker, 'site could not be read');
    assert.match(
      scoreCompany(row({ stack_signals: 'WordPress[meta+source]; robots:disallow-all' })).blocker ?? '',
      /robots/,
    );
    assert.match(scoreCompany(row({ stack_signals: 'redirect:other.example' })).blocker ?? '', /redirects/);
  });

  void it('ranks by score, then by traffic', () => {
    const ranked = rank([
      row({ website: 'small.example', stack_kind: 'legacy', stack_confidence: 'high', traffic: '2000' }),
      row({ website: 'big.example', stack_kind: 'legacy', stack_confidence: 'high', traffic: '900000' }),
      row({ website: 'headless.example', stack_kind: 'headless', stack_confidence: 'high', traffic: '900000' }),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.record.website),
      ['big.example', 'small.example', 'headless.example'],
    );
  });

  void it('rejects a weights file that adds up to more than 100 or has a wrong type', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-weights-'));
    const file = path.join(dir, 'w.json');
    fs.writeFileSync(file, JSON.stringify({ weights: { stack: 90, traffic: 30 } }));
    assert.throws(() => loadWeights(file), /add up to/);
    fs.writeFileSync(file, JSON.stringify({ weights: { stack: 'lots' } }));
    assert.throws(() => loadWeights(file), /must be a number/);
    fs.writeFileSync(file, JSON.stringify({ weights: { stack: 40, endOfLife: 0 } }));
    assert.equal(loadWeights(file).weights.stack, 40);
    assert.equal(loadWeights(file).weights.traffic, 20, 'missing keys keep their default');
  });
});

void describe('lead stages', () => {
  void it('reads the stage from the row when the column is empty', () => {
    assert.equal(stageOf({ website: 'a' }), 'new');
    assert.equal(stageOf({ website: 'a', fingerprinted_at: 'x', stack_kind: 'legacy' }), 'fingerprinted');
    assert.equal(stageOf({ website: 'a', fingerprinted_at: 'x', stack_kind: 'unreadable' }), 'unreadable');
    assert.equal(stageOf({ website: 'a', fingerprinted_at: 'x', stage: 'sent' }), 'sent');
  });

  void it('follows the lifecycle in the design', () => {
    assert.ok(canMove('fingerprinted', 'selected'));
    assert.ok(canMove('selected', 'scanned'));
    assert.ok(canMove('scanned', 'teaser_ready'));
    assert.ok(canMove('teaser_ready', 'approved'));
    assert.ok(canMove('approved', 'sent'));
    assert.ok(canMove('approved', 'scanned'), 'a failed same-day re-check sends it back');
    assert.ok(canMove('failed', 'selected'));
    assert.equal(canMove('new', 'sent'), false);
    assert.equal(canMove('scanned', 'sent'), false, 'nothing is sent without approval');
    assert.equal(canMove('teaser_ready', 'sent'), false);
  });

  void it('do_not_contact is reachable from everywhere and permanent', () => {
    for (const stage of STAGES) {
      if (stage === 'do_not_contact') continue;
      assert.ok(canMove(stage, 'do_not_contact'), stage);
      assert.equal(canMove('do_not_contact', stage), false, stage);
    }
  });

  void it('select only re-picks rows that have not been scanned', () => {
    assert.deepEqual(SELECTABLE_STAGES, ['fingerprinted', 'parked', 'selected']);
    assert.equal(MAX_SCAN_RETRIES, 2);
    assert.deepEqual(stageValues('selected', new Date('2026-11-13T10:00:00Z')), {
      stage: 'selected',
      stage_at: '2026-11-13T10:00:00.000Z',
    });
  });
});
