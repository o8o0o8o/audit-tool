import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, SKIP_DB, type TestDb } from './db-harness';
import {
  addAlias,
  findOrCreateSite,
  normalizeTarget,
  registrableDomainOf,
  resolveSites,
} from '../../web/lib/core/sites';

void test('site resolution: www, github.io (private suffix), IDN, page URL', () => {
  assert.deepEqual(normalizeTarget('WWW.Acme.com/pricing?x=1#top'), {
    url: 'https://www.acme.com',
    host: 'www.acme.com',
    registrableDomain: 'acme.com',
  });
  assert.equal(normalizeTarget('acme.github.io').registrableDomain, 'acme.github.io');
  assert.equal(normalizeTarget('shop.example.co.uk').registrableDomain, 'example.co.uk');
  const idn = normalizeTarget('https://bücher.de/');
  assert.equal(idn.host, 'xn--bcher-kva.de');
  assert.equal(idn.registrableDomain, 'xn--bcher-kva.de');
  assert.equal(normalizeTarget('https://acme.com/a/b#frag', true).url, 'https://acme.com/a/b');
  assert.equal(registrableDomainOf('127.0.0.1'), '127.0.0.1');
  assert.throws(() => normalizeTarget('ftp://acme.com'));
});

let t: TestDb;
before(async () => {
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => t?.close());

void test('site resolution: find or create; an alias finds its site', { skip: SKIP_DB }, async () => {
  const a = await findOrCreateSite(t.db, 'acme.com');
  const again = await findOrCreateSite(t.db, 'acme.com');
  assert.equal(a.id, again.id);
  await addAlias(t.db, 'www.acme.com', a.id, 'www');
  assert.equal((await findOrCreateSite(t.db, 'www.acme.com')).id, a.id);
  assert.equal((await resolveSites(t.db, 'https://www.acme.com/x'))[0]!.id, a.id);
  const blog = await findOrCreateSite(t.db, 'blog.acme.com');
  assert.notEqual(blog.id, a.id);
  assert.equal(
    (await resolveSites(t.db, 'shop.acme.com'))[0]!.id,
    a.id,
    'registrable-domain fallback prefers the apex',
  );
});
