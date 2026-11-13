import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleHtml } from '../lib/reports/html-utils';

void test('exampleHtml renders analyzer links instead of showing escaped markup', () => {
  const out = exampleHtml('<a href="https://x.com/a?b=1&amp;c=2">https://x.com/a</a> has no canonical');
  assert.match(
    out,
    /^<a href="https:\/\/x\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">https:\/\/x\.com\/a<\/a>/,
  );
});

void test('exampleHtml keeps page-supplied and unsafe markup inert', () => {
  const out = exampleHtml(
    'title &lt;a href=&quot;https://evil&quot;&gt;x&lt;/a&gt; <img src=x onerror=alert(1)> <a href="javascript:alert(1)">j</a>',
  );
  assert.ok(!/<a |<img/i.test(out), out);
});
