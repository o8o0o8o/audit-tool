import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildCrawlerBlockedBanner } from '../lib/phase2/phase2-runner';
import type { AuditArtifacts } from '../lib/phase2/types';

function artifacts(byError: Record<string, unknown>, totalWithoutError: number): Pick<AuditArtifacts, 'manifest'> {
  return {
    manifest: {
      progress: { processedPages: [], totalWithoutError, totalWithError: 0, byError, attempts: {} },
    },
  } as unknown as Pick<AuditArtifacts, 'manifest'>;
}

void describe('buildCrawlerBlockedBanner', () => {
  void it('says the site blocked the crawler and how many pages the audit covers', () => {
    const md = buildCrawlerBlockedBanner(artifacts({ '429': ['https://e.com/'], total429: 1 }, 0));
    assert.match(md, /Site blocked the crawler/);
    assert.match(md, /covers only 1 page\b/);
  });

  void it('adds nothing on a partial block', () => {
    assert.strictEqual(buildCrawlerBlockedBanner(artifacts({ '429': ['https://e.com/a'] }, 5)), '');
  });

  void it('adds nothing on a normal crawl or a plain server error', () => {
    assert.strictEqual(buildCrawlerBlockedBanner(artifacts({}, 10)), '');
    assert.strictEqual(buildCrawlerBlockedBanner(artifacts({ '503': ['https://e.com/'] }, 0)), '');
  });
});
