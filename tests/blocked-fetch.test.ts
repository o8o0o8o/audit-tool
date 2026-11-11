import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import {
  describeBlockedResponse,
  detectCrawlerBlocked,
  fetchWithRetryAfter,
  isChallengeResponse,
  parseRetryAfter,
  pickFinalMainFrameStatus,
} from '../lib/utils/blocked-fetch';
import { THRESHOLDS } from '../lib/constants';

void describe('describeBlockedResponse', () => {
  void it('carries status, server, retry-after, cf-ray, x-vercel-id and the body head', () => {
    const headers = new Headers({
      server: 'cloudflare',
      'retry-after': '12',
      'cf-ray': 'abc123-AMS',
      'x-vercel-id': 'fra1::xyz',
    });
    const line = describeBlockedResponse(429, headers, '<html>  Just a moment...</html>', 'https://e.com/robots.txt');
    assert.match(line, /HTTP 429 for https:\/\/e\.com\/robots\.txt/);
    assert.match(line, /server=cloudflare/);
    assert.match(line, /retry-after=12/);
    assert.match(line, /cf-ray=abc123-AMS/);
    assert.match(line, /x-vercel-id=fra1::xyz/);
    assert.match(line, /body="<html> Just a moment\.\.\.<\/html>"/);
  });

  void it('accepts a plain header record and marks missing headers', () => {
    const line = describeBlockedResponse(403, { Server: 'nginx' }, '');
    assert.match(line, /server=nginx/);
    assert.match(line, /cf-ray=-/);
  });

  void it('caps the body head at 200 characters', () => {
    const line = describeBlockedResponse(500, {}, 'x'.repeat(1000));
    assert.strictEqual(/body="(x*)"/.exec(line)![1]!.length, 200);
  });
});

void describe('parseRetryAfter', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  void it('reads delta-seconds', () => assert.strictEqual(parseRetryAfter('7', now), 7000));
  void it('reads an HTTP-date', () =>
    assert.strictEqual(parseRetryAfter(new Date(now + 10_000).toUTCString(), now), 10_000));
  void it('clamps to the max', () => {
    assert.strictEqual(parseRetryAfter('3600', now), THRESHOLDS.RETRY_AFTER_MAX_MS);
    assert.strictEqual(parseRetryAfter(new Date(now + 3_600_000).toUTCString(), now), THRESHOLDS.RETRY_AFTER_MAX_MS);
  });
  void it('falls back to the default for absent, 0, negative, past-date and garbage values', () => {
    for (const v of [null, undefined, '', '0', '-5', 'soon', new Date(now - 5000).toUTCString()]) {
      assert.strictEqual(parseRetryAfter(v, now), THRESHOLDS.RETRY_AFTER_DEFAULT_MS, String(v));
    }
  });
});

void describe('isChallengeResponse', () => {
  void it('recognises challenge headers', () => {
    assert.ok(isChallengeResponse(403, { 'cf-mitigated': 'challenge' }));
    assert.ok(isChallengeResponse(429, { 'x-vercel-mitigated': 'challenge' }));
    assert.ok(isChallengeResponse(503, { server: 'cloudflare' }));
  });
  void it('does not flag plain errors', () => {
    assert.ok(!isChallengeResponse(503, { server: 'nginx' }));
    assert.ok(!isChallengeResponse(200, { server: 'cloudflare' }));
    assert.ok(!isChallengeResponse(429, {}));
  });
});

function fakeFetch(sequence: Array<{ status: number; headers?: Record<string, string> }>) {
  let calls = 0;
  const doFetch = () => {
    const r = sequence[Math.min(calls, sequence.length - 1)]!;
    calls++;
    return Promise.resolve({ status: r.status, headers: new Headers(r.headers ?? {}) });
  };
  return { doFetch, calls: () => calls };
}

void describe('fetchWithRetryAfter', () => {
  void it('retries a 429 after Retry-After and returns the later success', async () => {
    const waits: number[] = [];
    const f = fakeFetch([{ status: 429, headers: { 'retry-after': '3' } }, { status: 200 }]);
    const res = await fetchWithRetryAfter(f.doFetch, { sleep: (ms) => (waits.push(ms), Promise.resolve()) });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(waits, [3000]);
  });

  void it('gives up after at most the max retries and returns the final 429', async () => {
    const waits: number[] = [];
    const f = fakeFetch([{ status: 429, headers: { 'retry-after': '999' } }]);
    const res = await fetchWithRetryAfter(f.doFetch, { sleep: (ms) => (waits.push(ms), Promise.resolve()) });
    assert.strictEqual(res.status, 429);
    assert.strictEqual(f.calls(), 1 + THRESHOLDS.RETRY_AFTER_MAX_RETRIES);
    assert.ok(waits.every((w) => w === THRESHOLDS.RETRY_AFTER_MAX_MS));
  });

  void it('uses the default back-off when Retry-After is absent', async () => {
    const waits: number[] = [];
    const f = fakeFetch([{ status: 429 }, { status: 200 }]);
    await fetchWithRetryAfter(f.doFetch, { sleep: (ms) => (waits.push(ms), Promise.resolve()) });
    assert.deepStrictEqual(waits, [THRESHOLDS.RETRY_AFTER_DEFAULT_MS]);
  });

  void it('does not retry a 403', async () => {
    const f = fakeFetch([{ status: 403 }, { status: 200 }]);
    const res = await fetchWithRetryAfter(f.doFetch, { sleep: () => Promise.resolve() });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(f.calls(), 1);
  });
});

void describe('pickFinalMainFrameStatus', () => {
  void it('pickFinalMainFrameStatus: a challenge followed by a 200 yields 200', () => {
    assert.strictEqual(
      pickFinalMainFrameStatus([
        { status: 429, headers: { 'x-vercel-mitigated': 'challenge' } },
        { status: 200, headers: {} },
      ]),
      200,
    );
  });
  void it('pickFinalMainFrameStatus: a first response without challenge headers keeps its status', () => {
    assert.strictEqual(
      pickFinalMainFrameStatus([
        { status: 429, headers: {} },
        { status: 200, headers: {} },
      ]),
      429,
    );
  });
  void it('pickFinalMainFrameStatus: a challenge that never clears yields the challenge status', () => {
    assert.strictEqual(pickFinalMainFrameStatus([{ status: 403, headers: { 'cf-mitigated': 'challenge' } }]), 403);
  });
  void it('pickFinalMainFrameStatus: no responses yields null', () => {
    assert.strictEqual(pickFinalMainFrameStatus([]), null);
  });
});

void describe('detectCrawlerBlocked', () => {
  void it('flags a crawl where every page got 429/403/challenge-503', () => {
    assert.deepStrictEqual(
      detectCrawlerBlocked({ byError: { '429': ['a'], total429: 1, 'challenge-503': ['b'] }, totalWithoutError: 0 }),
      { blocked: true, pages: 2 },
    );
  });
  void it('ignores a plain 503, a partial block and an empty crawl', () => {
    assert.ok(!detectCrawlerBlocked({ byError: { '503': ['a'] }, totalWithoutError: 0 }).blocked);
    assert.ok(!detectCrawlerBlocked({ byError: { '429': ['a'] }, totalWithoutError: 3 }).blocked);
    assert.ok(!detectCrawlerBlocked({ byError: { '429': ['a'], '404': ['b'] }, totalWithoutError: 0 }).blocked);
    assert.ok(!detectCrawlerBlocked({ byError: {}, totalWithoutError: 0 }).blocked);
  });
});

function codeOf(rel: string): string {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

void describe('call sites', () => {
  const fetchPaths = [
    'lib/parsers/robots-parser.ts',
    'lib/parsers/sitemap-parser.ts',
    'lib/crawler/crawler-engine.ts',
    'lib/crawler/browser-fetch.ts',
  ];
  for (const rel of fetchPaths) {
    void it(`${rel} logs describeBlockedResponse diagnostics`, () => {
      assert.match(codeOf(rel), /describeBlockedResponse\(/);
    });
  }
  for (const rel of fetchPaths.slice(0, 3)) {
    void it(`${rel} retries through fetchWithRetryAfter`, () => {
      assert.match(codeOf(rel), /fetchWithRetryAfter\(/);
    });
  }
  for (const rel of fetchPaths.slice(2)) {
    void it(`pickFinalMainFrameStatus is called by ${rel}`, () => {
      assert.match(codeOf(rel), /pickFinalMainFrameStatus\(/);
    });
  }
  void it('robots-parser keeps the "Error fetching robots.txt (HTTP" prefix for a final failure', () => {
    assert.match(codeOf('lib/parsers/robots-parser.ts'), /Error fetching robots\.txt \(HTTP \$\{/);
  });
});
