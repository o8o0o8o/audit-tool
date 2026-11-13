import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEmulatedLatencyToTtfb } from '../lib/crawler/vitals-collector';

void test('TTFB gains the emulated latency Navigation Timing misses; LCP sub-parts still sum to LCP', () => {
  const v = { TTFB: 66, lcpSubParts: { ttfb: 66, resourceDelay: 50, resourceLoad: 200, renderDelay: 30 } };
  const out = applyEmulatedLatencyToTtfb(v, 40, 161);
  assert.equal(out.TTFB, 187);
  const sp = out.lcpSubParts;
  assert.equal(sp.ttfb + sp.resourceDelay + sp.resourceLoad + sp.renderDelay, 66 + 50 + 200 + 30);
});

void test('TTFB is never lowered when CDP reports less than Navigation Timing', () => {
  assert.equal(applyEmulatedLatencyToTtfb({ TTFB: 100 }, 80, 60).TTFB, 100);
});
