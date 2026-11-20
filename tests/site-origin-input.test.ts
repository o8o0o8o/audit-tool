import { describe, it } from 'node:test';
import assert from 'node:assert';

import { toSiteOrigin, validateURL } from '../validators';
import { parseArgs } from '../lib/args-parser';
import { parseAuditRequest } from '../web/lib/audit-options';

void describe('site origin from user input', () => {
  const cases: Array<[string, string]> = [
    ['https://example.com', 'https://example.com'],
    ['https://example.com/', 'https://example.com'],
    ['https://www.example.com/blog/post?utm_source=x#top', 'https://www.example.com'],
    ['example.com', 'https://example.com'],
    ['example.com/pricing/', 'https://example.com'],
    ['  http://example.com:8080/a  ', 'http://example.com:8080'],
    ['//example.com/a', 'https://example.com'],
    ['HTTPS://Example.COM/Path', 'https://example.com'],
  ];
  for (const [input, expected] of cases) {
    void it(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.strictEqual(toSiteOrigin(input), expected);
    });
  }

  void it('leaves non-http input for validateURL to reject', () => {
    for (const input of ['ftp://example.com/x', 'javascript:alert(1)', 'not a url']) {
      assert.strictEqual(validateURL(toSiteOrigin(input)).valid, false, input);
    }
  });

  void it('--origin and --compare use the site origin and say so', () => {
    const args = parseArgs(['--origin=https://example.com/blog/post', '--compare=staging.example.com/x']);
    assert.strictEqual(args.origin, 'https://example.com');
    assert.strictEqual(args.compare, 'https://staging.example.com');
    assert.ok(args.warnings.some((w) => w.includes('auditing https://example.com')));
  });

  void it('no note for a plain site URL', () => {
    const args = parseArgs(['--origin=https://example.com/']);
    assert.strictEqual(args.origin, 'https://example.com');
    assert.deepStrictEqual(args.warnings, []);
  });

  void it('web form accepts a page or a bare host', () => {
    for (const url of ['example.com/blog/post', 'https://example.com/blog/post']) {
      const result = parseAuditRequest({ url });
      assert.ok(result.ok, url);
      if (result.ok) assert.strictEqual(result.options.url, 'https://example.com');
    }
  });
});
