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
    await exercise(new CsvProspectStore(csv, {}));
    const api = fakeApi();
    const csv2 = path.join(dir, 'untouched.csv');
    writeFileSync(csv2, CSV);
    await exercise(
      new ApiProspectStore('http://api.test', 'ak_x', api.f, { pendingFile: path.join(dir, 'pending.json') }),
    );
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

const PLATFORM = { AUDIT_API_URL: 'http://api.test', AUDIT_API_KEY: 'ak_x' };

void test('prospect store: the CSV guard also asks the platform when it is configured', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'store-'));
  try {
    const csv = path.join(dir, 'companies.csv');
    // The CSV calls nope.example an ordinary row; the platform says do_not_contact.
    writeFileSync(csv, 'company,website,stage\nAcme,acme.example,selected\nNope,nope.example,selected\n');
    const api = fakeApi();
    const store = new CsvProspectStore(csv, PLATFORM, api.f);
    assert.deepEqual(await store.guard('nope.example'), { allowed: false, reason: 'do_not_contact' });
    assert.equal((await store.guard('acme.example')).allowed, true);

    // A CSV do_not_contact row is refused without asking, whatever the platform says.
    writeFileSync(csv, 'company,website,stage\nAcme,acme.example,do_not_contact\n');
    assert.equal((await store.guard('acme.example')).allowed, false);

    // Platform configured but not answering: refused, with the address in the reason.
    writeFileSync(csv, 'company,website,stage\nAcme,acme.example,selected\n');
    const down = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const closed = await new CsvProspectStore(csv, PLATFORM, down).guard('acme.example');
    assert.equal(closed.allowed, false);
    assert.match(closed.reason ?? '', /http:\/\/api\.test.*could not be reached/);
    const denied = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    assert.equal((await new CsvProspectStore(csv, PLATFORM, denied).guard('acme.example')).allowed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('prospect store: updates the platform did not take are saved and sent first on the next load', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'store-'));
  try {
    const pendingFile = path.join(dir, 'lead-results', 'pending.json');
    const api = fakeApi();
    let up = true;
    const f = (async (url: string, init?: RequestInit) => {
      if (!up && init?.method === 'PATCH') throw new Error('connect ECONNREFUSED');
      return api.f(url, init);
    }) as typeof fetch;
    const opts = { pendingFile, retries: 2, retryDelayMs: 1 };

    const first = new ApiProspectStore('http://api.test', 'ak_x', f, opts);
    await first.load();
    up = false;
    first.update([{ website: 'acme.example', values: { stage: 'scanned' } }]);
    first.update([{ website: 'acme.example', values: { run_dir: 'lead-results/acme.example/x' } }]);
    await assert.rejects(first.flush(), /saved in .*pending\.json/);
    assert.equal(JSON.parse(readFileSync(pendingFile, 'utf8')).length, 2);
    assert.equal(api.rows[0]!.record.stage, 'fingerprinted');

    up = true;
    const second = new ApiProspectStore('http://api.test', 'ak_x', f, opts);
    await second.load();
    const row = second.records().find((r) => r.website === 'acme.example')!;
    assert.equal(row.stage, 'scanned');
    assert.equal(row.run_dir, 'lead-results/acme.example/x');
    assert.equal(api.rows[0]!.record.stage, 'scanned');
    assert.throws(() => readFileSync(pendingFile), 'the pending file is removed once sent');

    // A short outage is covered by the retries: nothing is saved.
    const third = new ApiProspectStore('http://api.test', 'ak_x', f, opts);
    await third.load();
    up = false;
    third.update([{ website: 'acme.example', values: { stage: 'teaser_ready' } }]);
    setTimeout(() => (up = true), 0);
    await third.flush();
    assert.equal(api.rows[0]!.record.stage, 'teaser_ready');

    // A platform that cannot be reached at load names its address and the CSV option.
    const dead = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    await assert.rejects(
      new ApiProspectStore('http://api.test', 'ak_x', dead, opts).load(),
      /http:\/\/api\.test.*--store=csv/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
