/**
 * The loader (design §3 "Saving a run", task 3.6): reads the model of the attempt that reported
 * `built`, loads it in chunks, each in its own transaction (delete this audit's rows of the chunk,
 * insert, record the chunk done), and sets `succeeded` after the last one. A crash resumes at the
 * next chunk. An unknown model major leaves the audit `built` with `load_blocked = model_version`.
 */
import { gunzipSync } from 'node:zlib';
import { and, asc, eq, inArray, isNull, like, sql } from 'drizzle-orm';
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
import { CHECK_TYPES, UNTYPED } from '@model/finding-codes';
import { SiteDocument } from '@model/site';
import { PageRecord, RunData } from '@model/page';
import { MODEL_VERSION, modelMajor } from '@model/version';
import { scoringVersion } from './rescore';

export const CHUNKS = ['site', 'findings', 'stack', 'gate', 'disclosures'] as const;
export type Chunk = (typeof CHUNKS)[number];

/** At most this many new derived codes per audit; the rest load as `untyped` (design §8.2). */
export const MAX_NEW_CODES = 20;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

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
  return JSON.parse(gunzipSync(Buffer.from(await new Response(got.body).arrayBuffer())).toString('utf8'));
}

async function loadChunk(tx: Tx, auditId: string, siteId: string, chunk: Chunk, doc: SiteDocument): Promise<void> {
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
      const [shot] = p.homepageScreenshot
        ? await tx
            .select({ id: artifacts.id })
            .from(artifacts)
            .where(and(eq(artifacts.auditId, auditId), like(artifacts.blobKey, `%/${p.homepageScreenshot}`)))
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
      const codes = [...new Set(doc.findings.map((f) => f.code))];
      const known = new Set(
        (await tx.select({ code: checkTypes.code }).from(checkTypes).where(inArray(checkTypes.code, codes))).map(
          (r) => r.code,
        ),
      );
      const fresh = codes.filter((c) => !known.has(c));
      const allowed = new Set(fresh.slice(0, MAX_NEW_CODES));
      if (fresh.length > MAX_NEW_CODES)
        console.warn(`[loader] ${auditId}: ${fresh.length - MAX_NEW_CODES} new codes loaded as untyped`);
      if (allowed.size) {
        await tx
          .insert(checkTypes)
          .values(
            [...allowed].map((code) => {
              const f = doc.findings.find((x) => x.code === code)!;
              return {
                code,
                title: f.title.slice(0, 300),
                category: f.category,
                defaultSeverity: f.severity,
                derived: true,
              };
            }),
          )
          .onConflictDoNothing();
      }
      for (let i = 0; i < doc.findings.length; i += 500) {
        await tx.insert(findings).values(
          doc.findings.slice(i, i + 500).map((f) => ({
            id: f.id,
            auditId,
            code: known.has(f.code) || allowed.has(f.code) ? f.code : UNTYPED,
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
      // A rescan that sees the same exposure updates the row; it never opens a second one.
      for (const d of doc.disclosures) {
        await tx
          .insert(disclosures)
          .values({ siteId, code: d.code, target: d.target, firstAuditId: auditId, lastSeenAuditId: auditId })
          .onConflictDoUpdate({
            target: [disclosures.siteId, disclosures.code, disclosures.target],
            set: { lastSeenAuditId: auditId },
          });
      }
      return;
    }
  }
}

async function readGzJson(files: FileStore, key: string): Promise<unknown> {
  const got = await files.get(key);
  if (!got) throw new Error(`${key} missing`);
  return JSON.parse(gunzipSync(Buffer.from(await new Response(got.body).arrayBuffer())).toString('utf8'));
}

/** Row chunks of the model (design §2 "Row parts"): run-data, pages-0001, pages-0002, … */
async function rowChunks(files: FileStore, prefix: string): Promise<string[]> {
  const out: string[] = [];
  for await (const f of files.list(`${prefix}model/`)) {
    const name = f.key.slice(`${prefix}model/`.length);
    if (name === 'run-data.json.gz') out.unshift('run-data');
    else if (/^pages-\d{4}\.ndjson\.gz$/.test(name)) out.push(name.replace('.ndjson.gz', ''));
  }
  return out;
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
    .map((l) => PageRecord.parse(JSON.parse(l)));
  await tx.delete(pages).where(and(eq(pages.auditId, auditId), eq(pages.chunk, n)));
  for (let i = 0; i < records.length; i += 100) {
    await tx.insert(pages).values(records.slice(i, i + 100).map((r) => ({ auditId, chunk: n, ...r })));
  }
}

export interface LoadResult {
  auditId: string;
  outcome: 'succeeded' | 'blocked' | 'partial' | 'failed' | 'skipped';
  chunks: number;
}

/** Loads one audit as far as the time budget allows. */
export async function loadAudit(
  db: Db,
  files: FileStore,
  auditId: string,
  opts: {
    deadline?: number;
    onFinished?: (auditId: string) => Promise<void>;
    knownMajor?: number;
    failAfterChunks?: number;
    now?: Date;
  } = {},
): Promise<LoadResult> {
  const [audit] = await db.select().from(audits).where(eq(audits.id, auditId));
  if (!audit || !['built', 'loading'].includes(audit.status) || audit.loadBlocked)
    return { auditId, outcome: 'skipped', chunks: 0 };
  let raw: unknown;
  try {
    raw = await readSiteDocument(files, auditId, audit.currentAttempt);
  } catch (err) {
    await db
      .update(audits)
      .set({ error: `load: ${(err as Error).message}` })
      .where(eq(audits.id, auditId));
    return { auditId, outcome: 'failed', chunks: 0 };
  }
  const version = String((raw as { modelVersion?: unknown })?.modelVersion ?? '');
  const known = opts.knownMajor ?? modelMajor(MODEL_VERSION);
  let major: number;
  try {
    major = modelMajor(version);
  } catch {
    major = -1;
  }
  if (major !== known) {
    // Version skew: wait for the next deploy; this does not count as a failed attempt.
    await db.update(audits).set({ loadBlocked: 'model_version', status: 'built' }).where(eq(audits.id, auditId));
    console.warn(`[loader] ${auditId}: model ${version} needs a newer app (knows major ${known})`);
    return { auditId, outcome: 'blocked', chunks: 0 };
  }
  const doc = SiteDocument.parse(raw);
  await db.update(audits).set({ status: 'loading', phase: 'load' }).where(eq(audits.id, auditId));
  await seedCheckTypes(db);
  const done = new Set(
    (await db.select({ chunk: loadProgress.chunk }).from(loadProgress).where(eq(loadProgress.auditId, auditId))).map(
      (r) => r.chunk,
    ),
  );
  let n = 0;
  for (const chunk of CHUNKS) {
    if (done.has(chunk)) continue;
    if (opts.deadline && Date.now() > opts.deadline) return { auditId, outcome: 'partial', chunks: n };
    if (opts.failAfterChunks !== undefined && n >= opts.failAfterChunks) throw new Error('simulated loader crash');
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'load:' + auditId}))`);
      await loadChunk(tx, auditId, audit.siteId, chunk, doc);
      await tx
        .insert(loadProgress)
        .values({ auditId, chunk })
        .onConflictDoUpdate({ target: [loadProgress.auditId, loadProgress.chunk], set: { doneAt: new Date() } });
    });
    n++;
  }
  // Row parts: the run's own data and one row per page, so the report renders from the database.
  const prefix = `audits/${auditId}/${audit.currentAttempt}/`;
  for (const chunk of await rowChunks(files, prefix)) {
    if (done.has(chunk)) continue;
    if (opts.deadline && Date.now() > opts.deadline) return { auditId, outcome: 'partial', chunks: n };
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'load:' + auditId}))`);
      await loadRowChunk(tx, files, prefix, auditId, chunk);
      await tx
        .insert(loadProgress)
        .values({ auditId, chunk })
        .onConflictDoUpdate({ target: [loadProgress.auditId, loadProgress.chunk], set: { doneAt: new Date() } });
    });
    n++;
  }
  await db
    .update(audits)
    .set({
      status: 'succeeded',
      scoringVersion: scoringVersion(),
      phase: null,
      finishedAt: audit.finishedAt ?? opts.now ?? new Date(),
      modelVersion: doc.modelVersion,
      error: null,
    })
    .where(and(eq(audits.id, auditId), inArray(audits.status, ['built', 'loading'])));
  await opts.onFinished?.(auditId);
  return { auditId, outcome: 'succeeded', chunks: n };
}

/** Loader cron: every built/loading audit without a load block, until the time budget is used. */
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
    .orderBy(asc(audits.createdAt))
    .limit(50);
  const out: LoadResult[] = [];
  for (const r of rows) {
    if (Date.now() > deadline) break;
    try {
      out.push(await loadAudit(db, files, r.id, { deadline, onFinished: opts.onFinished }));
    } catch (err) {
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
