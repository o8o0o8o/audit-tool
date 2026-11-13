import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  actionable,
  applyUpdates,
  domainOf,
  originOf,
  parseCsv,
  parseTable,
  readCompanies,
  readTable,
  serializeCsv,
  updateCompanies,
  withFileLock,
} from '../lib/leads/csv-store';

const SAMPLE = [
  'company,website,source,cms,languages,traffic,open_jobs,has_audit',
  'Acme,acme.com,"GTM chunk;artifact, v2",wordpress,2,417,0,yes',
  '"Quote ""Co""",quote.co,sheet,contentful,1,12000,3,',
  'Stop Inc,stop.example,sheet,,1,5,0,',
  '',
].join('\n');

function tempCsv(content: string = SAMPLE): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leads-csv-'));
  const file = path.join(dir, 'companies.csv');
  fs.writeFileSync(file, content);
  return file;
}

void describe('leads csv store', () => {
  void it('round-trips quoted fields, embedded commas and quotes', () => {
    const rows = parseCsv(SAMPLE);
    assert.equal(rows[1][2], 'GTM chunk;artifact, v2');
    assert.equal(rows[2][0], 'Quote "Co"');
    assert.equal(serializeCsv(rows), SAMPLE);
  });

  void it('keeps CRLF line endings', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    const file = tempCsv(crlf);
    updateCompanies(file, [{ website: 'acme.com', values: { has_audit: 'failed' } }]);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('\r\n'));
    assert.equal(text.replace(/\r\n/g, '').includes('\n'), false);
  });

  void it('normalises websites to a domain and an origin', () => {
    assert.equal(domainOf('https://www.Example.com/path?x=1'), 'example.com');
    assert.equal(domainOf('shop.example.co.uk:8443'), 'shop.example.co.uk');
    assert.equal(originOf('example.com/'), 'https://example.com');
    assert.equal(originOf('http://example.com'), 'http://example.com');
  });

  void it('adds new columns at the end and leaves other cells alone', () => {
    const file = tempCsv();
    const missing = updateCompanies(file, [
      { website: 'quote.co', values: { stack_kind: 'legacy', cms_detected: 'Drupal' } },
      { website: 'nope.example', values: { stack_kind: 'unknown' } },
    ]);
    assert.deepEqual(missing, ['nope.example']);
    const table = readTable(file);
    assert.deepEqual(table.header.slice(-2), ['stack_kind', 'cms_detected']);
    const records = readCompanies(file);
    assert.equal(records[1].stack_kind, 'legacy');
    assert.equal(records[1].company, 'Quote "Co"');
    assert.equal(records[0].stack_kind, '');
    assert.equal(records[0].has_audit, 'yes');
    assert.equal(records[0].source, 'GTM chunk;artifact, v2');
  });

  void it('a write only touches its own columns, so two writers do not undo each other', () => {
    const file = tempCsv();
    // Writer A (lead pipeline) and writer B (batch full audit) each read the file long ago…
    updateCompanies(file, [{ website: 'acme.com', values: { stack_kind: 'legacy' } }]);
    // …and B now writes its own column without knowing about A's change.
    updateCompanies(file, [{ website: 'acme.com', values: { has_audit: 'failed' } }]);
    const acme = readCompanies(file)[0];
    assert.equal(acme.stack_kind, 'legacy');
    assert.equal(acme.has_audit, 'failed');
  });

  void it('never moves a row out of do_not_contact, and skips such rows', () => {
    const table = parseTable(SAMPLE);
    const first = applyUpdates(table, [{ website: 'stop.example', values: { stage: 'do_not_contact' } }]).table;
    const second = applyUpdates(first, [
      { website: 'stop.example', values: { stage: 'selected', fit_score: '80' } },
    ]).table;
    const stop = second.rows.find((r) => r[1] === 'stop.example')!;
    assert.equal(stop[second.header.indexOf('stage')], 'do_not_contact');

    const file = tempCsv(serializeCsv([second.header, ...second.rows]));
    const websites = actionable(readCompanies(file)).map((r) => r.website);
    assert.deepEqual(websites, ['acme.com', 'quote.co']);
  });

  void it('leaves no lock or temp file behind, and takes over a lock left by a dead process', () => {
    const file = tempCsv();
    fs.writeFileSync(`${file}.lock`, '999999999'); // no such process
    updateCompanies(file, [{ website: 'acme.com', values: { stage: 'selected' } }]);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['companies.csv']);
    assert.equal(readCompanies(file)[0].stage, 'selected');
  });

  void it('releases the lock when the callback throws', () => {
    const file = tempCsv();
    assert.throws(
      () =>
        withFileLock(file, () => {
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.equal(fs.existsSync(`${file}.lock`), false);
  });
});
