/**
 * The loader (design §3 "Saving a run", task 3.6): reads the model of the attempt that reported
 * `built`, loads it in chunks, each in its own transaction (delete this audit's rows of the chunk,
 * insert, record the chunk done), and sets `succeeded` after the last one. A crash resumes at the
 * next chunk. An unknown model major leaves the audit `built` with `load_blocked = model_version`.
 *
 * A load that throws is counted (`load_attempts`) and its error recorded; the third failure sets
 * the audit `failed`, so a model that cannot be loaded neither blocks the queue nor keeps the site
 * from being scanned again. A reload of a `succeeded` audit runs in one transaction: readers see the
 * old rows until the new ones are in, and a failed reload changes nothing.
 */
import { gunzipSync } from 'node:zlib';
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { Db } from '../../db/client';
import {
  artifacts,
  auditDocuments,
  auditRunData,
  audits,
  checkTypes,
  pages,
  disclosures,
  fieldMetrics,
  findings,
  leadFacts,
  leadGateRuns,
  loadProgress,
  recommendations,
  scanQuality,
  scores,
  siteChecks,
  siteProfiles,
  technologies,
  trackingIds,
} from '../../db/schema';
import type { FileStore } from '../platform/types';
import { CHECK_TYPES, UNTYPED, deriveCode } from '@model/finding-codes';
import { SiteDocument } from '@model/site';
import { PageRecord, RunData } from '@model/page';
import { pgSafe, pgSafeText } from '@model/pg-safe';
import { MODEL_VERSION, modelMajor } from '@model/version';

export const CHUNKS = ['site', 'findings', 'stack', 'gate', 'disclosures'] as const;
export type Chunk = (typeof CHUNKS)[number];

/** Derived codes the vocabulary may hold; past it a finding without a known code loads as `untyped`. */
export const MAX_DERIVED_CODES = 2000;
/** Failed loads before the audit is set `failed`. */
export const MAX_LOAD_ATTEMPTS = 3;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type AuditRow = typeof audits.$inferSelect;

export async function seedCheckTypes(db: Db | Tx): Promise<void> {
  await db
    .insert(checkTypes)
    .values([
      { code: UNTYPED, title: 'Finding without a code', derived: false },
      ...CHECK_TYPES.map((c) => ({
        code: c.code,
        title: c.title,
        family: c.family,
        category: c.category,
        defaultSeverity: c.default_severity,
        derived: false,
      })),
    ])
    .onConflictDoNothing();
}

export async function readSiteDocument(files: FileStore, auditId: string, attempt: number): Promise<unknown> {
  const got = await files.get(`audits/${auditId}/${attempt}/model/site.json.gz`);
  if (!got) throw new Error(`model/site.json.gz missing for attempt ${attempt}`);
  return pgSafe(JSON.parse(gunzipSync(Buffer.from(await new Response(got.body).arrayBuffer())).toString('utf8')));
}

/**
 * Finding codes as they are stored, in the `findings` rows and in the site document alike. A code
 * is kept when it is a known check type, or when the finding's title is a stable check title that
 * derives exactly this code (it then becomes a new derived check type). Anything else is `untyped`,
 * title kept. The rule depends on the title and on codes that only ever get added, so loading the
 * same audit again gives the same codes.
 */
export async function resolveCodes(db: Db, auditId: string, doc: SiteDocument): Promise<SiteDocument> {
  const codes = [
    ...new Set([...doc.findings.map((f) => f.code), ...doc.recommendations.flatMap((r) => r.codes)]),
  ].filter((c) => c !== UNTYPED);
  if (!codes.length) return doc;
  const known = new Set<string>();
  for (let i = 0; i < codes.length; i += 1000)
    for (const r of await db
      .select({ code: checkTypes.code })
      .from(checkTypes)
      .where(inArray(checkTypes.code, codes.slice(i, i + 1000))))
      known.add(r.code);
  const fresh = new Map<string, SiteDocument['findings'][number]>();
  const refused: string[] = [];
  for (const f of doc.findings) {
    if (f.code === UNTYPED || known.has(f.code) || fresh.has(f.code)) continue;
    if (deriveCode(f.title).code === f.code) fresh.set(f.code, f);
    else refused.push(f.title);
  }
  if (fresh.size) {
    const [have] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(checkTypes)
      .where(eq(checkTypes.derived, true));
    const room = Math.max(0, MAX_DERIVED_CODES - (have?.n ?? 0));
    for (const code of [...fresh.keys()].sort().slice(room)) {
      refused.push(fresh.get(code)!.title);
      fresh.delete(code);
    }
  }
  if (fresh.size) {
    await db
      .insert(checkTypes)
      .values(
        [...fresh.values()].map((f) => ({
          code: f.code,
          title: f.title.slice(0, 300),
          category: f.category,
          defaultSeverity: f.severity,
          derived: true,
        })),
      )
      .onConflictDoNothing();
    console.warn(
      `[loader] ${auditId}: ${fresh.size} new finding code(s): ${[...fresh.values()].map((f) => JSON.stringify(f.title)).join(', ')}`,
    );
  }
  if (refused.length)
    console.warn(
      `[loader] ${auditId}: ${refused.length} finding(s) loaded as untyped: ${refused
        .slice(0, 20)
        .map((t) => JSON.stringify(t.slice(0, 120)))
        .join(', ')}`,
    );
  const keep = (code: string) => (known.has(code) || fresh.has(code) ? code : UNTYPED);
  return {
    ...doc,
    findings: doc.findings.map((f) => ({ ...f, code: keep(f.code) })),
    recommendations: doc.recommendations.map((r) => ({ ...r, codes: [...new Set(r.codes.map(keep))] })),
  };
}

async function loadChunk(tx: Tx, audit: AuditRow, chunk: Chunk, doc: SiteDocument): Promise<void> {
  const auditId = audit.id;
  switch (chunk) {
    case 'site': {
      const json = JSON.stringify(doc);
      await tx.delete(auditDocuments).where(eq(auditDocuments.auditId, auditId));
      await tx
        .insert(auditDocuments)
        .values({ auditId, modelVersion: doc.modelVersion, document: doc, bytes: Buffer.byteLength(json) });
      await tx.delete(scanQuality).where(eq(scanQuality.auditId, auditId));
      const q = doc.scanQuality;
      await tx.insert(scanQuality).values({
        auditId,
        state: q.state,
        reasons: q.reasons,
        homepageRead: q.homepageRead,
        pagesRequested: q.pagesRequested,
        pagesOk: q.pagesOk,
        pagesBlocked: q.pagesBlocked,
        pagesFailed: q.pagesFailed,
        errorsByType: q.errorsByType,
        botProtection: q.botProtection,
        sitemapTotal: q.sitemapTotal,
        sitemapCrawled: q.sitemapCrawled,
        probesBlocked: q.probesBlocked,
      });
      await tx.delete(scores).where(eq(scores.auditId, auditId));
      const scoreRows = [...new Map(doc.scores.map((s) => [s.category, s])).values()];
      if (scoreRows.length)
        await tx
          .insert(scores)
          .values(scoreRows.map((s) => ({ auditId, category: s.category, score: s.score, source: s.source })));
      await tx.delete(recommendations).where(eq(recommendations.auditId, auditId));
      if (doc.recommendations.length) {
        await tx.insert(recommendations).values(
          doc.recommendations.map((r) => ({
            auditId,
            rank: r.rank,
            title: r.title,
            codes: r.codes,
            impact: r.impact,
            effort: r.effort,
            quickWin: r.quickWin,
            fix: r.fix,
            pagesAffected: r.pagesAffected,
          })),
        );
      }
      await tx.delete(siteChecks).where(eq(siteChecks.auditId, auditId));
      const checkRows = [...new Map(doc.siteChecks.map((c) => [c.checkId, c])).values()];
      if (checkRows.length)
        await tx.insert(siteChecks).values(
          checkRows.map((c) => ({
            auditId,
            checkId: c.checkId,
            label: c.label,
            status: c.status,
            note: c.note,
            details: c.details ?? null,
          })),
        );
      await tx.delete(siteProfiles).where(eq(siteProfiles.auditId, auditId));
      const p = doc.siteProfile;
      // Exact suffix (no LIKE: `_` and `%` in a path are not wildcards); this attempt's file first.
      const suffix = `/${p.homepageScreenshot}`;
      const [shot] = p.homepageScreenshot
        ? await tx
            .select({ id: artifacts.id })
            .from(artifacts)
            .where(and(eq(artifacts.auditId, auditId), sql`right(${artifacts.blobKey}, ${suffix.length}) = ${suffix}`))
            .orderBy(
              sql`(${artifacts.blobKey} = ${`audits/${auditId}/${audit.currentAttempt}${suffix}`}) desc`,
              desc(artifacts.createdAt),
              asc(artifacts.id),
            )
            .limit(1)
        : [];
      await tx.insert(siteProfiles).values({
        auditId,
        languages: p.languages,
        multilang: p.multilang,
        aiCrawlerRules: p.aiCrawlerRules,
        llmsTxt: p.llmsTxt,
        schemaTypes: p.schemaTypes,
        httpVersion: p.httpVersion,
        cdn: p.cdn,
        securityHeaders: p.securityHeaders,
        hasContactForm: p.hasContactForm,
        formProviders: p.formProviders,
        ctas: p.ctas,
        bookingLinks: p.bookingLinks,
        homepageScreenshotArtifactId: shot?.id ?? null,
      });
      await tx.delete(fieldMetrics).where(eq(fieldMetrics.auditId, auditId));
      if (doc.fieldMetrics.length)
        await tx.insert(fieldMetrics).values(doc.fieldMetrics.map((m) => ({ auditId, ...m })));
      return;
    }
    case 'findings': {
      await tx.delete(findings).where(eq(findings.auditId, auditId));
      if (!doc.findings.length) return;
      for (let i = 0; i < doc.findings.length; i += 500) {
        await tx.insert(findings).values(
          doc.findings.slice(i, i + 500).map((f) => ({
            id: f.id,
            auditId,
            code: f.code,
            params: f.params,
            title: f.title,
            severity: f.severity,
            category: f.category,
            scope: f.scope,
            occurrences: f.occurrences,
            pagesTotal: f.pagesTotal,
          })),
        );
      }
      return;
    }
    case 'stack': {
      await tx.delete(technologies).where(eq(technologies.auditId, auditId));
      await tx.delete(trackingIds).where(eq(trackingIds.auditId, auditId));
      if (!doc.stack) return;
      const iso = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);
      if (doc.stack.technologies.length) {
        await tx.insert(technologies).values(
          doc.stack.technologies.map((t) => ({
            auditId,
            name: t.name,
            kind: t.kind,
            version: t.version,
            confidence: t.confidence,
            eolDate: iso(t.eolDate),
            evidence: t.evidence ?? null,
          })),
        );
      }
      const ids = [...new Map(doc.stack.trackingIds.map((t) => [`${t.kind}:${t.value}`, t])).values()];
      if (ids.length) await tx.insert(trackingIds).values(ids.map((t) => ({ auditId, ...t })));
      return;
    }
    case 'gate': {
      // Workflow gate runs come from the model; pipeline runs are appended through the API and kept.
      await tx.delete(leadGateRuns).where(and(eq(leadGateRuns.auditId, auditId), eq(leadGateRuns.source, 'workflow')));
      for (const g of doc.gateRuns) {
        const [row] = await tx
          .insert(leadGateRuns)
          .values({
            auditId,
            runAt: new Date(g.runAt),
            source: g.source,
            teaserReady: g.teaserReady,
            candidatesDropped: g.candidatesDropped,
            previous: g.previous ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: leadGateRuns.id });
        if (row && g.facts.length) {
          await tx.insert(leadFacts).values(
            g.facts.map((f) => ({
              gateRunId: row.id,
              type: f.type,
              rootCause: f.rootCause,
              weight: f.weight,
              fact: f.fact,
              url: f.url,
              gate: f.gate,
              dependsOn: f.dependsOn,
              evidence: f.evidence ?? {},
            })),
          );
        }
      }
      return;
    }
    case 'disclosures': {
      // A rescan that sees the same exposure updates the row; it never opens a second one. First
      // and last are decided by when the audits ran, not by the order they were loaded in.
      const at = (audit.finishedAt ?? audit.createdAt).toISOString();
      const ranAt = (col: typeof disclosures.firstAuditId | typeof disclosures.lastSeenAuditId) =>
        sql`(select coalesce(a.finished_at, a.created_at) from audits a where a.id = ${col})`;
      for (const d of doc.disclosures) {
        await tx
          .insert(disclosures)
          .values({
            siteId: audit.siteId,
            code: d.code,
            target: d.target,
            firstAuditId: auditId,
            lastSeenAuditId: auditId,
          })
          .onConflictDoUpdate({
            target: [disclosures.siteId, disclosures.code, disclosures.target],
            set: {
              firstAuditId: sql`case when ${disclosures.firstAuditId} is null or ${ranAt(disclosures.firstAuditId)} > ${at}::timestamptz then ${auditId}::uuid else ${disclosures.firstAuditId} end`,
              lastSeenAuditId: sql`case when ${disclosures.lastSeenAuditId} is null or ${ranAt(disclosures.lastSeenAuditId)} <= ${at}::timestamptz then ${auditId}::uuid else ${disclosures.lastSeenAuditId} end`,
            },
          });
      }
      return;
    }
  }
}

async function readGzJson(files: FileStore, key: string): Promise<unknown> {
  const got = await files.get(key);
  if (!got) throw new Error(`${key} missing`);
  return pgSafe(JSON.parse(gunzipSync(Buffer.from(await new Response(got.body).arrayBuffer())).toString('utf8')));
}

/** Row chunks of the model (design §2 "Row parts"): run-data, pages-0001, pages-0002, … */
async function rowChunks(files: FileStore, prefix: string): Promise<string[]> {
  const out: string[] = [];
  for await (const f of files.list(`${prefix}model/`)) {
    const name = f.key.slice(`${prefix}model/`.length);
    if (name === 'run-data.json.gz') out.unshift('run-data');
    else if (/^pages-\d{4}\.ndjson\.gz$/.test(name)) out.push(name.replace('.ndjson.gz', ''));
  }
  // listing order is the store's; chunks load in page order so the first record of a URL wins
  return out.sort((a, b) => (a === 'run-data' ? -1 : b === 'run-data' ? 1 : a < b ? -1 : 1));
}

async function loadRowChunk(tx: Tx, files: FileStore, prefix: string, auditId: string, chunk: string): Promise<void> {
  if (chunk === 'run-data') {
    const data = RunData.parse(await readGzJson(files, `${prefix}model/run-data.json.gz`));
    await tx.delete(auditRunData).where(eq(auditRunData.auditId, auditId));
    await tx
      .insert(auditRunData)
      .values((Object.keys(data) as (keyof RunData)[]).map((name) => ({ auditId, name, data: data[name] })));
    return;
  }
  const n = Number(chunk.slice('pages-'.length));
  const got = await files.get(`${prefix}model/${chunk}.ndjson.gz`);
  if (!got) throw new Error(`${chunk} missing`);
  const records = gunzipSync(Buffer.from(await new Response(got.body).arrayBuffer()))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => PageRecord.parse(pgSafe(JSON.parse(l))));
  // One row per URL (`pages_audit_url`): the first record wins, within the chunk and across chunks.
  const unique = [...new Map(records.reverse().map((r) => [r.url, r])).values()].reverse();
  await tx.delete(pages).where(and(eq(pages.auditId, auditId), eq(pages.chunk, n)));
  for (let i = 0; i < unique.length; i += 100) {
    await tx
      .insert(pages)
      .values(unique.slice(i, i + 100).map((r) => ({ auditId, chunk: n, ...r })))
      .onConflictDoNothing();
  }
}

export interface LoadResult {
  auditId: string;
  outcome: 'succeeded' | 'blocked' | 'partial' | 'failed' | 'skipped';
  chunks: number;
  error?: string;
}

interface LoadOptions {
  deadline?: number;
  onFinished?: (auditId: string) => Promise<void>;
  knownMajor?: number;
  /** Test hook: the process dies after this many chunks (not a counted failure). */
  failAfterChunks?: number;
  now?: Date;
  /** Load a `succeeded` audit again, in one transaction (see `reloadAudit`). */
  reload?: boolean;
}

class SimulatedCrash extends Error {}

const pageChunkNumber = (chunk: string) => Number(chunk.slice('pages-'.length));

/** One line for `audits.error`: a schema error as its first few issues, not zod's full JSON. */
function describeError(err: unknown): string {
  if (err instanceof ZodError) {
    const issues = err.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return `model does not match the schema: ${issues.join('; ')}${err.issues.length > 5 ? ` (+${err.issues.length - 5} more)` : ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Counts a failed load and records its error; the third failure sets the audit `failed`. */
async function recordLoadFailure(db: Db, auditId: string, err: unknown, opts: LoadOptions): Promise<LoadResult> {
  const error = pgSafeText(`load: ${describeError(err)}`).slice(0, 2000);
  const active = and(eq(audits.id, auditId), inArray(audits.status, ['built', 'loading']));
  const [row] = await db
    .update(audits)
    .set({ loadAttempts: sql`${audits.loadAttempts} + 1`, error })
    .where(active)
    .returning({ n: audits.loadAttempts, finishedAt: audits.finishedAt });
  console.error(`[loader] ${auditId} failed (attempt ${row?.n ?? '?'} of ${MAX_LOAD_ATTEMPTS}): ${error}`);
  if (row && row.n >= MAX_LOAD_ATTEMPTS) {
    const [failed] = await db
      .update(audits)
      .set({ status: 'failed', phase: null, finishedAt: row.finishedAt ?? opts.now ?? new Date() })
      .where(active)
      .returning({ id: audits.id });
    if (failed) await opts.onFinished?.(auditId);
  }
  return { auditId, outcome: 'failed', chunks: 0, error };
}

/** Loads one audit as far as the time budget allows. */
export async function loadAudit(
  db: Db,
  files: FileStore,
  auditId: string,
  opts: LoadOptions = {},
): Promise<LoadResult> {
  const [audit] = await db.select().from(audits).where(eq(audits.id, auditId));
  const reload = !!opts.reload && audit?.status === 'succeeded';
  if (!audit || audit.loadBlocked || !(reload || ['built', 'loading'].includes(audit.status)))
    return { auditId, outcome: 'skipped', chunks: 0 };
  try {
    return reload ? await reloadSucceeded(db, files, audit, opts) : await loadBuilt(db, files, audit, opts);
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err;
    if (!reload) return recordLoadFailure(db, auditId, err, opts);
    // A failed reload rolled back: the audit stays `succeeded` with the rows it had.
    const error = describeError(err);
    console.error(`[loader] reload of ${auditId} failed, rows unchanged: ${error}`);
    return { auditId, outcome: 'failed', chunks: 0, error };
  }
}

function modelMajorOf(raw: unknown): { version: string; major: number } {
  const version = String((raw as { modelVersion?: unknown })?.modelVersion ?? '');
  try {
    return { version, major: modelMajor(version) };
  } catch {
    return { version, major: -1 };
  }
}

async function markChunk(tx: Tx, auditId: string, chunk: string): Promise<void> {
  await tx
    .insert(loadProgress)
    .values({ auditId, chunk })
    .onConflictDoUpdate({ target: [loadProgress.auditId, loadProgress.chunk], set: { doneAt: new Date() } });
}

/** Page rows of chunks the model no longer has (a rebuild with fewer pages) go. */
async function dropStalePages(tx: Tx, auditId: string, chunks: string[]): Promise<void> {
  const numbers = chunks.filter((c) => c !== 'run-data').map(pageChunkNumber);
  await tx
    .delete(pages)
    .where(
      numbers.length ? and(eq(pages.auditId, auditId), notInArray(pages.chunk, numbers)) : eq(pages.auditId, auditId),
    );
}

async function loadBuilt(db: Db, files: FileStore, audit: AuditRow, opts: LoadOptions): Promise<LoadResult> {
  const auditId = audit.id;
  const raw = await readSiteDocument(files, auditId, audit.currentAttempt);
  const known = opts.knownMajor ?? modelMajor(MODEL_VERSION);
  const { version, major } = modelMajorOf(raw);
  if (major !== known) {
    // Version skew: wait for the next deploy; this does not count as a failed attempt.
    await db.update(audits).set({ loadBlocked: 'model_version', status: 'built' }).where(eq(audits.id, auditId));
    console.warn(`[loader] ${auditId}: model ${version} needs a newer app (knows major ${known})`);
    return { auditId, outcome: 'blocked', chunks: 0 };
  }
  const parsed = SiteDocument.parse(raw);
  await db
    .update(audits)
    .set({ status: 'loading', phase: 'load' })
    .where(and(eq(audits.id, auditId), inArray(audits.status, ['built', 'loading'])));
  await seedCheckTypes(db);
  const doc = await resolveCodes(db, auditId, parsed);
  const done = new Set(
    (await db.select({ chunk: loadProgress.chunk }).from(loadProgress).where(eq(loadProgress.auditId, auditId))).map(
      (r) => r.chunk,
    ),
  );
  const locked = (fn: (tx: Tx) => Promise<void>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'load:' + auditId}))`);
      await fn(tx);
    });
  let n = 0;
  for (const chunk of CHUNKS) {
    if (done.has(chunk)) continue;
    if (opts.deadline && Date.now() > opts.deadline) return { auditId, outcome: 'partial', chunks: n };
    if (opts.failAfterChunks !== undefined && n >= opts.failAfterChunks)
      throw new SimulatedCrash('simulated loader crash');
    await locked(async (tx) => {
      await loadChunk(tx, audit, chunk, doc);
      await markChunk(tx, auditId, chunk);
    });
    n++;
  }
  // Row parts: the run's own data and one row per page, so the report renders from the database.
  const prefix = `audits/${auditId}/${audit.currentAttempt}/`;
  const rows = await rowChunks(files, prefix);
  for (const chunk of rows) {
    if (done.has(chunk)) continue;
    if (opts.deadline && Date.now() > opts.deadline) return { auditId, outcome: 'partial', chunks: n };
    await locked(async (tx) => {
      await loadRowChunk(tx, files, prefix, auditId, chunk);
      await markChunk(tx, auditId, chunk);
    });
    n++;
  }
  await locked(async (tx) => {
    await dropStalePages(tx, auditId, rows);
    // `scoring_version` stays empty: the scores are the run's own, not this app's scoring code's.
    await tx
      .update(audits)
      .set({
        status: 'succeeded',
        scoringVersion: null,
        scoreAttempts: 0,
        phase: null,
        finishedAt: audit.finishedAt ?? opts.now ?? new Date(),
        modelVersion: doc.modelVersion,
        error: null,
      })
      .where(and(eq(audits.id, auditId), inArray(audits.status, ['built', 'loading'])));
  });
  await opts.onFinished?.(auditId);
  return { auditId, outcome: 'succeeded', chunks: n };
}

/**
 * Loads a `succeeded` audit again from its model files (after a rebuild). Everything happens in one
 * transaction and the status never changes, so readers see the old rows until the commit and a
 * failure leaves them as they were.
 */
async function reloadSucceeded(db: Db, files: FileStore, audit: AuditRow, opts: LoadOptions): Promise<LoadResult> {
  const auditId = audit.id;
  const raw = await readSiteDocument(files, auditId, audit.currentAttempt);
  const known = opts.knownMajor ?? modelMajor(MODEL_VERSION);
  const { version, major } = modelMajorOf(raw);
  if (major !== known) {
    console.warn(`[loader] ${auditId}: model ${version} needs a newer app (knows major ${known}); not reloaded`);
    return { auditId, outcome: 'blocked', chunks: 0 };
  }
  const parsed = SiteDocument.parse(raw);
  await seedCheckTypes(db);
  const doc = await resolveCodes(db, auditId, parsed);
  const prefix = `audits/${auditId}/${audit.currentAttempt}/`;
  const rows = await rowChunks(files, prefix);
  let n = 0;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'load:' + auditId}))`);
    await tx.delete(loadProgress).where(eq(loadProgress.auditId, auditId));
    for (const chunk of CHUNKS) {
      await loadChunk(tx, audit, chunk, doc);
      await markChunk(tx, auditId, chunk);
      n++;
    }
    if (rows.length) await tx.delete(pages).where(eq(pages.auditId, auditId));
    for (const chunk of rows) {
      await loadRowChunk(tx, files, prefix, auditId, chunk);
      await markChunk(tx, auditId, chunk);
      n++;
    }
    await tx
      .update(audits)
      .set({ scoringVersion: null, scoreAttempts: 0, modelVersion: doc.modelVersion })
      .where(eq(audits.id, auditId));
  });
  return { auditId, outcome: 'succeeded', chunks: n };
}

/**
 * Loader cron: built/loading audits without a load block, until the time budget is used. Audits
 * that failed before go last, and a failing one is counted and passed over, so it never holds the
 * others; after MAX_LOAD_ATTEMPTS it is `failed` and leaves the queue.
 */
export async function runLoader(
  db: Db,
  files: FileStore,
  opts: { budgetMs?: number; onFinished?: (auditId: string) => Promise<void> } = {},
): Promise<LoadResult[]> {
  const deadline = Date.now() + (opts.budgetMs ?? 4 * 60_000);
  const rows = await db
    .select({ id: audits.id })
    .from(audits)
    .where(and(inArray(audits.status, ['built', 'loading']), isNull(audits.loadBlocked)))
    .orderBy(asc(audits.loadAttempts), asc(audits.createdAt))
    .limit(50);
  const out: LoadResult[] = [];
  for (const r of rows) {
    if (Date.now() > deadline) break;
    try {
      out.push(await loadAudit(db, files, r.id, { deadline, onFinished: opts.onFinished }));
    } catch (err) {
      // loadAudit records its own failures; this is the recording itself failing (database down)
      console.error(`[loader] ${r.id} failed; retried on the next pass`, err);
      out.push({ auditId: r.id, outcome: 'failed', chunks: 0 });
    }
  }
  return out;
}

/** After a deploy that knows the model's major: clear `model_version` blocks so the loader retries. */
export async function clearVersionBlocks(db: Db): Promise<void> {
  await db.update(audits).set({ loadBlocked: null }).where(eq(audits.loadBlocked, 'model_version'));
}
