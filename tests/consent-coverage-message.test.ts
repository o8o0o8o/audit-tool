import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AnalyticsValidator } from '../lib/analyzers/site-wide/analytics-validator';
import type { PageInfo } from '../lib/types';

const page = (hasCookieConsent: boolean) =>
  ({ analytics: { hasGA4: true, hasCookieConsent, trackingIds: { ga4: ['G-1'] } } }) as unknown as PageInfo;

const messages = (pages: Record<string, PageInfo>) =>
  (AnalyticsValidator.validateAnalyticsImplementation(pages).issues as { message: string }[]).map((i) => i.message);

void describe('site-wide consent coverage message', () => {
  void it('says the banner is missing when no page has consent (not "inconsistent")', () => {
    const out = messages({ 'https://x.test/': page(false), 'https://x.test/a': page(false) });
    assert.ok(out.includes('Tracking cookies without consent banner'));
    assert.ok(!out.includes('Inconsistent cookie consent implementation'));
  });

  void it('keeps "inconsistent" when some pages have consent and others do not', () => {
    const pages: Record<string, PageInfo> = { 'https://x.test/': page(true) };
    for (let i = 0; i < 4; i++) pages[`https://x.test/${i}`] = page(false);
    assert.ok(messages(pages).includes('Inconsistent cookie consent implementation'));
  });
});
