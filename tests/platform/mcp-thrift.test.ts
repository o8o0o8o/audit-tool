/**
 * What the MCP server costs its reader: the tool list a session pays for once, and the answers an
 * assistant pays for on every call. These hold the sizes down (`web/lib/mcp/thrift.ts`).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createTestDb, SKIP_DB, type TestDb } from './db-harness';
import { FakeDispatcher, tempStore } from './helpers';
import { audits } from '../../web/db/schema';
import { startAudit } from '../../web/lib/core/audits';
import { internalPrincipal } from '../../web/lib/core/principal';
import { buildMcpServer } from '../../web/lib/mcp/tools';
import {
  answerText,
  capDetails,
  compact,
  MAX_ANSWER_CHARS,
  shortLeadRow,
  slimAudit,
  slimAuditRow,
} from '../../web/lib/mcp/thrift';
import type { LeadSummaryRow } from '../../lib/model/lead-summary';

// The SDK is a dependency of web/, not of the repo root.
const req = createRequire(path.join(__dirname, '../../web/package.json'));
const { Client } = req(
  '@modelcontextprotocol/sdk/client/index.js',
) as typeof import('../../web/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { InMemoryTransport } = req(
  '@modelcontextprotocol/sdk/inMemory.js',
) as typeof import('../../web/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');

let t: TestDb;
const files = tempStore();
before(async () => {
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => {
  await t?.close();
  files.cleanup();
});

void test('compact: null and empty are left out; false and 0 are answers and stay', () => {
  assert.deepEqual(
    compact({
      a: null,
      b: undefined,
      c: '',
      d: [],
      e: {},
      f: false,
      g: 0,
      h: 'x',
      i: { j: null, k: [] },
      l: [{ m: null, n: 1 }, {}],
      o: { p: { q: null } },
    }),
    { f: false, g: 0, h: 'x', l: [{ n: 1 }, {}] },
  );
  assert.equal(compact(null), null);
  assert.deepEqual(compact([1, null, 'a']), [1, null, 'a'], 'array items keep their places');
});

void test('answer text: compact JSON, and a plain note when a caller asked for too much', () => {
  assert.equal(
    answerText({ a: 1, found: [], row: null, gone: undefined, c: [{ d: 'x', e: [], f: null }] }),
    '{"a":1,"found":[],"row":null,"c":[{"d":"x"}]}',
    'the answer keeps its own fields; rows drop their empty ones',
  );
  const big = answerText({ rows: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: 'row '.repeat(5) })) });
  const parsed = JSON.parse(big) as { truncated: boolean; note: string; data: string };
  assert.equal(parsed.truncated, true);
  assert.match(parsed.note, /Ask for less/);
  assert.ok(parsed.data.length <= MAX_ANSWER_CHARS);
});

void test('slim shapes: counts in place of file rows, the first details and how many, a short lead row', () => {
  const audit = slimAudit({
    audit_id: 'a',
    status: 'succeeded',
    links: { internal: '/internal/audits/a' },
    artifacts: [
      { id: '1', kind: 'report_html', key: 'k1', bytes: 1 },
      { id: '2', kind: 'report_md', key: 'k2', bytes: 1 },
      ...Array.from({ length: 300 }, (_, i) => ({ id: `e${i}`, kind: 'evidence', key: `k${i}`, bytes: 1 })),
      { id: '3', kind: 'raw_archive', key: 'k3', bytes: 1 },
    ],
  });
  assert.deepEqual(audit, {
    audit_id: 'a',
    status: 'succeeded',
    reports: ['report_html', 'report_md'],
    other_files: { evidence: 300, raw_archive: 1 },
  });

  assert.deepEqual(capDetails(['a', 'b']), { details: ['a', 'b'] });
  assert.deepEqual(capDetails(Array.from({ length: 40 }, (_, i) => i)), {
    details: [0, 1, 2, 3, 4],
    details_total: 40,
  });
  assert.deepEqual(capDetails(null), {});

  const row = slimAuditRow({
    audit_id: 'a',
    domain: 'acme.example',
    target_url: 'https://acme.example',
    mode: 'quick',
    preset: null,
    legacy_run_id: null,
    created_at: '2026-11-23T06:39:04.014Z',
    finished_at: '2026-11-23T06:41:10.500Z',
  });
  assert.deepEqual(row, {
    audit_id: 'a',
    domain: 'acme.example',
    mode: 'quick',
    created_at: '2026-11-23T06:39',
    finished_at: '2026-11-23T06:41',
  });
  assert.equal(
    slimAuditRow({ mode: 'page', target_url: 'https://acme.example/p', domain: 'acme.example' }).target_url,
    'https://acme.example/p',
  );

  const full = {
    audit_id: 'a',
    domain: 'acme.example',
    mode: 'quick',
    scanned_at: '2026-11-23T06:41:10.500Z',
    scan_quality: 'ok',
    outreach_blocked: false,
    scores: { overall: 61 },
    issues: { total: 40, critical: 1, high: 6, by_category: { seo: 20 } },
    facts: { heavy: 1, medium: 2, light: 0, top: [{ fact: 'Software past end of life' }], teaser_ready: true },
    field_speed: { cwv_pass: false },
    stack: { cms: 'WordPress', framework: null },
    prospect: null,
    quick_wins: [{ title: 'x' }],
  } as unknown as LeadSummaryRow;
  assert.deepEqual(shortLeadRow(full), {
    audit_id: 'a',
    domain: 'acme.example',
    mode: 'quick',
    scanned_at: '2026-11-23',
    scan_quality: 'ok',
    outreach_blocked: false,
    teaser_ready: true,
    score: 61,
    issues: { critical: 1, high: 6, total: 40 },
    facts: { heavy: 1, medium: 2, light: 0 },
    top_fact: 'Software past end of life',
    cms: 'WordPress',
    framework: null,
    cwv_pass: false,
    prospect_stage: null,
  });
});

void test(
  'MCP server: a small tool list, one compact copy of each answer, short lists by default',
  { skip: SKIP_DB },
  async () => {
    await t.db.delete(audits);
    const me = internalPrincipal();
    for (let i = 0; i < 30; i++) await startAudit(t.db, me, { url: `thrift-${i}.example`, mode: 'quick' });
    const server = buildMcpServer({
      db: t.db,
      platform: {
        mode: 'local',
        files: files.store,
        dispatcher: new FakeDispatcher(),
        identity: { verify: async () => null },
      },
      principal: me,
      appUrl: 'http://app.example',
      reportSecret: 'x'.repeat(40),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);

    // Paid once per session, used or not.
    const { tools } = await client.listTools();
    const listSize = JSON.stringify(tools).length;
    assert.ok(listSize < 17_000, `tool list is ${listSize} characters`);
    for (const tool of tools) {
      assert.equal(tool.outputSchema, undefined, `${tool.name} sends no output schema`);
      assert.ok(
        (tool.description ?? '').length < 900,
        `${tool.name}: description is ${(tool.description ?? '').length}`,
      );
    }
    assert.match(client.getInstructions() ?? '', /missing field means/);

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: { type: string; text: string }[];
        structuredContent?: unknown;
        isError?: boolean;
      };
      assert.equal(res.structuredContent, undefined, `${name}: one copy of the answer`);
      assert.equal(res.content.length, 1);
      const text = res.content[0]!.text;
      assert.ok(!/\n/.test(text), `${name}: no indentation`);
      return { text, data: JSON.parse(text) as Record<string, any>, isError: res.isError };
    };

    const list = await call('list_audits');
    assert.equal(list.data.count, 20, '20 by default, not all 30');
    assert.ok(!('legacy_run_id' in list.data.audits[0]) && !('target_url' in list.data.audits[0]));
    assert.ok(!/null/.test(list.text), 'no null fields');
    assert.ok(list.text.length < 4500, `list_audits is ${list.text.length} characters`);
    assert.equal((await call('list_audits', { limit: 30 })).data.count, 30);

    const one = await call('get_audit', { audit_id: list.data.audits[0].audit_id });
    assert.ok(!('artifacts' in one.data) && !('links' in one.data));
    assert.ok(one.text.length < 700, `get_audit is ${one.text.length} characters`);

    const wait = await call('wait_for_audit', { audit_id: list.data.audits[0].audit_id, timeout_seconds: 1 });
    assert.ok(wait.text.length < 600, `wait_for_audit is ${wait.text.length} characters`);
    assert.equal(wait.data.finished, false);

    // The vocabulary is hundreds of rows where it is loaded: never all at once.
    const types = await call('list_check_types');
    assert.ok(Array.isArray(types.data.check_types) && types.data.check_types.length <= 25);
    assert.ok(types.data.total >= types.data.check_types.length);
    for (const c of types.data.check_types)
      assert.deepEqual(Object.keys(c).sort(), ['category', 'code', 'default_severity', 'title']);

    // A list that finds nothing still says so in the same shape.
    const summaries = await call('list_lead_summaries');
    assert.deepEqual(summaries.data, { summaries: [], count: 0, next_cursor: null });
    const prospects = await call('list_prospects');
    assert.equal(prospects.data.count, prospects.data.prospects.length);
    assert.equal(prospects.data.more, false);

    const bad = await call('get_audit', { audit_id: '00000000-0000-4000-8000-000000000000' });
    assert.equal(bad.isError, true);
    await client.close();
  },
);
