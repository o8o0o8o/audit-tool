/** Webhooks, report tokens, secrets masking, prospects, PDF jobs, the public profile. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createTestDb, eq, SKIP_DB, type TestDb } from './db-harness';
import { SECRET, writeFixtureRun } from './helpers';
import { artifacts, audits, jobs, prospects, webhookDeliveries } from '../../web/db/schema';
import { createApiKey, authenticateApiKey } from '../../web/lib/core/auth';
import { deliverDueWebhooks, onAuditFinished, postWebhook } from '../../web/lib/core/webhooks';
import { makeReportToken, reportTokenAudit, REPORT_HEADERS, findArtifactByPath } from '../../web/lib/core/reports';
import { maskSecretsInRun, readMaskRecord } from '../../lib/platform-worker/mask-secrets';
import { CoreError } from '../../web/lib/core/errors';
import { getProspect, listProspects, patchProspect, rowFromRecord, upsertProspect } from '../../web/lib/core/prospects';
import { requestPdf } from '../../web/lib/core/jobs';
import { findOrCreateSite } from '../../web/lib/core/sites';
import { siteProbeSteps } from '../../lib/analyzers/site-checks/site-probes';
import type { Principal } from '../../web/lib/core/principal';

let t: TestDb;
let server: http.Server;
let port = 0;
const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
let failNext = 0;
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = failNext-- > 0 ? 500 : 200;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => {
  server.close();
  await t?.close();
});

const code = (c: string) => (e: unknown) => e instanceof CoreError && e.code === c;

async function finishedAudit(clientId: string | null, status = 'succeeded') {
  const site = await findOrCreateSite(t.db, `w${randomUUID().slice(0, 8)}.example`);
  const id = randomUUID();
  await t.db
    .insert(audits)
    .values({
      id,
      siteId: site.id,
      mode: 'quick',
      targetUrl: `https://${site.host}`,
      profile: 'standard',
      profileHash: id,
      comparableKey: 'k',
      status,
      source: 'api',
      createdByClientId: clientId,
      externalRef: 'crm:1',
      currentAttempt: 1,
      finishedAt: new Date(),
    });
  return id;
}

void test('webhooks: one signed delivery on success; a retry after a 500', { skip: SKIP_DB }, async () => {
  const k = await createApiKey(t.db, {
    name: 'hook',
    scopes: ['audits:read'],
    webhookUrl: `http://127.0.0.1:${port}/hook`,
  });
  const id = await finishedAudit(k.id);
  failNext = 1;
  const now = new Date('2026-11-21T10:00:00Z');
  await onAuditFinished(t.db, id, now);
  assert.equal(await deliverDueWebhooks(t.db, { now, allowPrivate: true }), 0);
  const [d1] = await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.auditId, id));
  assert.equal(d1!.statusCode, 500);
  assert.equal(d1!.nextAttemptAt!.getTime(), now.getTime() + 60_000);
  assert.equal(
    await deliverDueWebhooks(t.db, { now: new Date(now.getTime() + 30_000), allowPrivate: true }),
    0,
    'not due yet',
  );
  assert.equal(await deliverDueWebhooks(t.db, { now: new Date(now.getTime() + 61_000), allowPrivate: true }), 1);
  const last = received.at(-1)!;
  const body = JSON.parse(last.body);
  assert.equal(body.event, 'audit.succeeded');
  assert.equal(body.external_ref, 'crm:1');
  const ts = String(last.headers['x-audit-timestamp']);
  assert.equal(
    last.headers['x-audit-signature'],
    `sha256=${createHmac('sha256', k.webhookSecret!).update(`${ts}.${last.body}`).digest('hex')}`,
  );
  assert.equal(
    await deliverDueWebhooks(t.db, { now: new Date(now.getTime() + 3600_000), allowPrivate: true }),
    0,
    'delivered once',
  );
});

void test('webhooks: a localhost address is refused outside local mode', async () => {
  await assert.rejects(postWebhook(`http://127.0.0.1:${port}/x`, {}, '{}', false), /private/);
  await assert.rejects(postWebhook('http://localhost:1/x', {}, '{}', false), /private/);
});

void test(
  'report tokens: expired or altered refused; headers; a path outside the audit refused',
  { skip: SKIP_DB },
  async () => {
    const id = await finishedAudit(null);
    const now = Date.now();
    const tok = makeReportToken(id, SECRET, now);
    assert.equal(reportTokenAudit(tok, SECRET, now), id);
    assert.equal(reportTokenAudit(tok, SECRET, now + 3601_000), null);
    assert.equal(reportTokenAudit(tok.slice(0, -3) + 'abc', SECRET, now), null);
    assert.equal(reportTokenAudit(tok, 'another-secret-another-secret-123', now), null);
    assert.match(REPORT_HEADERS['Content-Security-Policy'], /^sandbox/);
    assert.equal(REPORT_HEADERS['Referrer-Policy'], 'no-referrer');
    await t.db
      .insert(artifacts)
      .values({
        auditId: id,
        kind: 'screenshot',
        blobKey: `audits/${id}/1/evidence/x/screenshot.png`,
        bytes: 1,
        sha256: 'a'.repeat(64),
      });
    assert.ok(await findArtifactByPath(t.db, id, ['evidence', 'x', 'screenshot.png']));
    assert.equal(await findArtifactByPath(t.db, id, ['..', 'other', 'x.png']), null);
    const other = await finishedAudit(null);
    assert.equal(await findArtifactByPath(t.db, other, ['evidence', 'x', 'screenshot.png']), null);
  },
);

void test('secrets masking: a stored script with a planted key is masked; the recorded hash is the original', () => {
  const { runDir, cleanup } = writeFixtureRun();
  try {
    const key = 'sk_live_' + '51H8xQ2eZvKYlo2C9vWbV0q'.padEnd(24, 'a');
    mkdirSync(path.join(runDir, 'lead', 'evidence', 'r1'), { recursive: true });
    const file = path.join(runDir, 'lead', 'evidence', 'r1', 'app.js');
    const original = `var stripe = Stripe("${key}");`;
    writeFileSync(file, original);
    const rec = maskSecretsInRun(runDir);
    const masked = readFileSync(file, 'utf8');
    assert.ok(!masked.includes(key), 'key no longer on disk');
    const r = rec['lead/evidence/r1/app.js']!;
    assert.equal(r.sha256Original, require('node:crypto').createHash('sha256').update(original).digest('hex'));
    assert.deepEqual(readMaskRecord(runDir), rec);
  } finally {
    cleanup();
  }
});

void test('prospects: rows keep CSV columns; do_not_contact flagged and never changed', { skip: SKIP_DB }, async () => {
  const k = await createApiKey(t.db, { name: 'pipe', scopes: ['prospects:read', 'prospects:write'] });
  const p: Principal = await authenticateApiKey(t.db, `Bearer ${k.key}`);
  const row = rowFromRecord({ company: 'Nope', website: 'www.nope.example', stage: 'do_not_contact', run_dir: 'x' });
  assert.equal(row.doNotContact, true);
  assert.deepEqual(row.registrableDomains, ['nope.example']);
  const a = await upsertProspect(t.db, p, {
    company: 'Acme',
    website: 'acme-p.example',
    stage: 'fingerprinted',
    fit_score: '42',
    cms: 'wordpress',
  });
  assert.equal(a.record.cms, 'wordpress');
  assert.equal(a.fit_score, 42);
  const moved = await patchProspect(t.db, p, a.id, { stage: 'selected', scan_note: 'hi' });
  assert.equal(moved.stage, 'selected');
  assert.equal(moved.record.scan_note, 'hi');
  const dnc = await upsertProspect(t.db, p, { company: 'Nope', website: 'nope.example', stage: 'do_not_contact' });
  await assert.rejects(patchProspect(t.db, p, dnc.id, { stage: 'selected' }), code('do_not_contact'));
  assert.equal((await getProspect(t.db, p, 'www.acme-p.example'))?.company, 'Acme');
  assert.equal((await listProspects(t.db, p, { do_not_contact: true })).length >= 1, true);
  const readOnly = await createApiKey(t.db, { name: 'ro', scopes: ['audits:read'] });
  await assert.rejects(
    listProspects(t.db, await authenticateApiKey(t.db, `Bearer ${readOnly.key}`)),
    code('forbidden'),
  );
  void prospects;
});

void test(
  'request_pdf: a second request joins the first job; ready when the PDF exists',
  { skip: SKIP_DB },
  async () => {
    const k1 = await createApiKey(t.db, { name: 'pdf1', scopes: ['audits:read', 'audits:pdf'] });
    const k2 = await createApiKey(t.db, { name: 'pdf2', scopes: ['audits:read', 'audits:pdf'] });
    const p1 = await authenticateApiKey(t.db, `Bearer ${k1.key}`);
    const p2 = await authenticateApiKey(t.db, `Bearer ${k2.key}`);
    const id = await finishedAudit(k1.id);
    await assert.rejects(requestPdf(t.db, p1, { audit_id: id, kind: 'pdf' }), code('not_generated'));
    await t.db
      .insert(artifacts)
      .values({
        auditId: id,
        kind: 'report_md',
        blobKey: `audits/${id}/1/audit-report.md`,
        bytes: 1,
        sha256: 'a'.repeat(64),
      });
    const a = await requestPdf(t.db, p1, { audit_id: id, kind: 'pdf' });
    const b = await requestPdf(t.db, p2, { audit_id: id, kind: 'pdf' });
    assert.equal(a.job_id, b.job_id);
    const [job] = await t.db.select().from(jobs).where(eq(jobs.id, a.job_id!));
    assert.equal(job!.requestedBy.length, 2);
    await t.db
      .insert(artifacts)
      .values({
        auditId: id,
        kind: 'report_pdf',
        blobKey: `audits/${id}/1/audit-report.pdf`,
        bytes: 1,
        sha256: 'a'.repeat(64),
      });
    assert.equal((await requestPdf(t.db, p1, { audit_id: id, kind: 'pdf' })).status, 'ready');
  },
);

void test('run profiles: a public-profile run has neither the secrets scan nor the takeover check', () => {
  const names = (profile: 'public' | 'standard') =>
    siteProbeSteps('https://acme.com', {}, { profile, skipBrowser: true }).map(([n]) => n);
  assert.ok(names('standard').includes('JS secrets'));
  assert.ok(names('standard').includes('subdomain takeover'));
  assert.ok(!names('public').includes('JS secrets'));
  assert.ok(!names('public').includes('subdomain takeover'));
});
