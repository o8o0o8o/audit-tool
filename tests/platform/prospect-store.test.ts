import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ApiProspectStore,
  CsvProspectStore,
  openProspectStore,
  type ProspectStore,
} from '../../lib/leads/prospect-store';

const CSV = 'company,website,stage,fit_score\nAcme,acme.example,fingerprinted,10\nNope,nope.example,do_not_contact,\n';

/** A fake prospect API with the semantics of web/lib/core/prospects.ts. */
function fakeApi() {
  const rows = [
    {
      id: 'a',
      website: 'acme.example',
      record: { company: 'Acme', website: 'acme.example', stage: 'fingerprinted', fit_score: '10' },
    },
    {
      id: 'n',
      website: 'nope.example',
      record: { company: 'Nope', website: 'nope.example', stage: 'do_not_contact', fit_score: '' },
    },
  ];
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push(`${init?.method} ${u.pathname}${u.search}`);
    if (u.pathname === '/api/v1/prospects') return new Response(JSON.stringify({ prospects: rows }));
    if (u.pathname === '/api/v1/guard')
      return new Response(
        JSON.stringify(
          u.searchParams.get('domain') === 'nope.example'
            ? { allowed: false, reason: 'do_not_contact' }
            : { allowed: true },
        ),
      );
    const m = u.pathname.match(/^\/api\/v1\/prospects\/(\w+)$/);
    if (m && init?.method === 'PATCH') {
      const row = rows.find((r) => r.id === m[1])!;
      if (row.record.stage === 'do_not_contact') return new Response('{"error":"do_not_contact"}', { status: 403 });
      Object.assign(row.record, JSON.parse(String(init.body)).values);
      return new Response(JSON.stringify(row));
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { f, rows, calls };
}

async function exercise(store: ProspectStore) {
  await store.load();
  assert.equal(store.records().length, 2);
  const missing = store.update([
    { website: 'acme.example', values: { stage: 'selected', scan_note: 'x' } },
    { website: 'nope.example', values: { stage: 'selected' } },
    { website: 'ghost.example', values: { stage: 'selected' } },
  ]);
  assert.deepEqual(missing, ['ghost.example']);
  await store.flush();
  const after = store.records();
  assert.equal(after.find((r) => r.website === 'acme.example')!.stage, 'selected');
  assert.equal(after.find((r) => r.website === 'acme.example')!.scan_note, 'x');
  assert.equal(
    after.find((r) => r.website === 'nope.example')!.stage,
    'do_not_contact',
    'do_not_contact never changes',
  );
  assert.equal((await store.guard('nope.example')).allowed, false);
  assert.equal((await store.guard('acme.example')).allowed, true);
}

void test('prospect store: the CSV and API implementations behave the same', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'store-'));
  try {
    const csv = path.join(dir, 'companies.csv');
    writeFileSync(csv, CSV);
    await exercise(new CsvProspectStore(csv));
    const api = fakeApi();
    const csv2 = path.join(dir, 'untouched.csv');
    writeFileSync(csv2, CSV);
    await exercise(new ApiProspectStore('http://api.test', 'ak_x', api.f));
    assert.equal(readFileSync(csv2, 'utf8'), CSV, 'the API store never writes the CSV');
    assert.ok(api.calls.includes('PATCH /api/v1/prospects/a'));
    assert.ok(!api.calls.includes('PATCH /api/v1/prospects/n'), 'no write is even attempted for a do_not_contact row');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('prospect store: the API store is chosen when configured', () => {
  assert.equal(openProspectStore({ csvPath: 'x.csv', env: {} }).kind, 'csv');
  assert.equal(
    openProspectStore({ csvPath: 'x.csv', env: { AUDIT_API_URL: 'http://a', AUDIT_API_KEY: 'k' } }).kind,
    'api',
  );
  assert.equal(
    openProspectStore({ csvPath: 'x.csv', store: 'csv', env: { AUDIT_API_URL: 'http://a', AUDIT_API_KEY: 'k' } }).kind,
    'csv',
  );
});
