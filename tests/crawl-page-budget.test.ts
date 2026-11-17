import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crawlPageBudget } from '../lib/seo-data';

void describe('crawlPageBudget', () => {
  void it('has no cap without --limit', () => {
    assert.equal(crawlPageBudget(null, false), null);
    assert.equal(crawlPageBudget(undefined, false), null);
  });
  void it('caps a full audit at the sitemap pass plus the discovered pass', () => {
    assert.equal(crawlPageBudget(150, false), 300);
  });
  void it('keeps the lead scan cap at the limit itself', () => {
    assert.equal(crawlPageBudget(25, true), 25);
  });
});
