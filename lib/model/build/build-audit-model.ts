/**
 * buildAuditModel (design §2): the only code that knows raw analyzer shapes. It reshapes what the
 * run computed; it never re-runs an analyzer and never changes a score or a severity. It marks
 * blocked pages and drops the findings raised only on them; a blocked scan has no scores.
 *
 * Output: `<run>/model/site.json.gz` (the site document) and `<run>/model/raw-archive.tar.gz`
 * (the run's *.json.gz and report text, without screenshots and evidence).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { categorize } from '../../phase2/categorize';
import { deriveCode, findingId } from '../finding-codes';
import { computeScanQuality } from '../scan-quality';
import { SiteDocument, type Finding } from '../site';
import { MODEL_VERSION } from '../version';
import { PAGE_CHUNK_SIZE, PageRecord, type RunData } from '../page';
import { factDependsOn, vendorKind } from '../vendor-kinds';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const readGz = (file: string): Json | null => {
  try {
    return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as Json;
  } catch {
    return null;
  }
};
const readJson = (file: string): Json | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Json;
  } catch {
    return null;
  }
};

export interface BuildInput {
  runDir: string;
  auditId: string;
  mode?: 'full' | 'quick' | 'page';
  profile?: 'public' | 'standard' | null;
  preset?: string | null;
  /** Fingerprint result (FingerprintResult) when it is not in `<run>/platform/stack.json`. */
  stack?: Json | null;
  /** Who ran the gate runs found in the folder: the workflow step, or the lead pipeline on our machines. */
  gateSource?: 'workflow' | 'pipeline';
}

const AI_CRAWLERS = [
  'GPTBot',
  'ClaudeBot',
  'PerplexityBot',
  'Google-Extended',
  'CCBot',
  'anthropic-ai',
  'OAI-SearchBot',
];
const BOOKING =
  /calendly\.com|hubspot\.com\/meetings|meetings\.hubspot|cal\.com|acuityscheduling|youcanbook\.me|chilipiper|savvycal|zcal\.co|tidycal/i;

const linkUrls = (s: string) => [...s.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
const plain = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

export function loadRunPages(runDir: string, manifest: Json | null): Json[] {
  const pages: Json[] = [];
  for (const b of (manifest?.files?.pageBatches ?? []) as Array<{ file: string }>) {
    const data = readGz(path.join(runDir, b.file));
    for (const [url, p] of Object.entries((data?.pages ?? {}) as Record<string, Json>))
      pages.push({ ...p, url: p.url ?? url });
  }
  return pages;
}

export function buildAuditModel(input: BuildInput): SiteDocument {
  const { runDir } = input;
  const manifest = readGz(path.join(runDir, 'manifest.json.gz'));
  if (!manifest) throw new Error(`not a run folder (no readable manifest.json.gz): ${runDir}`);
  const metadata = readGz(path.join(runDir, 'metadata.json.gz')) ?? {};
  const analysis = readGz(path.join(runDir, 'analysis.json.gz')) ?? {};
  const pages = loadRunPages(runDir, manifest);
  const domain: string = manifest.domain ?? path.basename(path.dirname(runDir));
  const mode = input.mode ?? (metadata.leadScan ? 'quick' : metadata.singlePage ? 'page' : 'full');
  const home: string =
    metadata.leadScan?.home ??
    (metadata.singlePage?.url as string | undefined) ??
    pages.find((p) => /^https?:\/\/[^/]+\/?$/.test(p.url))?.url ??
    `https://${domain}/`;
  const keyUrl = mode === 'page' ? ((metadata.singlePage?.url as string) ?? pages[0]?.url ?? home) : home;

  // ── Scan quality ───────────────────────────────────────────────────────────
  const checks = ((metadata.siteChecks?.checks ?? []) as Json[]).filter((c) => c && c.id);
  const probesBlocked = checks.filter(
    (c) => c.status === 'skipped' && /blocked|refused|403|429|rate.?limit/i.test(String(c.note ?? '')),
  ).length;
  const homePage = pages.find((p) => p.url === keyUrl) ?? pages[0];
  const quality = computeScanQuality({
    keyUrl,
    pages: pages.map((p) => ({
      url: p.url,
      finalUrl: p.finalUrl ?? null,
      status: p.status ?? null,
      redirectOnly: p.redirectOnly,
    })),
    byError: manifest.progress?.byError ?? {},
    sitemapTotal:
      typeof metadata.sitemaps?.total === 'number' && metadata.sitemaps.total > 0
        ? metadata.sitemaps.total
        : (metadata.leadScan?.sitemapTotal ?? null),
    sitemapCrawled: pages.filter((p) => p.foundIn === 'sitemap').length || null,
    probesBlocked,
    botProtection: homePage?.caching?.cdnProvider ?? null,
  });
  const { blockedUrls, ...scanQuality } = quality;
  const blocked = scanQuality.state === 'blocked';

  // ── Findings ───────────────────────────────────────────────────────────────
  const details = (analysis.details ?? {}) as Record<string, Json>;
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const [title, d] of Object.entries(details)) {
    const examples: string[] = Array.isArray(d.examples) ? d.examples.map(String) : [];
    const urls = examples.flatMap(linkUrls);
    // A blocked request is never evidence: drop a finding raised only on blocked pages.
    if (urls.length && urls.every((u) => blockedUrls.has(u))) continue;
    const { code, params } = deriveCode(title);
    const severity = String(d.severity ?? 'low').toLowerCase();
    let id = findingId(input.auditId, code, params);
    if (seen.has(id)) id = findingId(input.auditId, code, { ...params, title });
    seen.add(id);
    findings.push({
      id,
      code,
      params,
      title: plain(title),
      severity: (['critical', 'high', 'medium', 'low'].includes(severity) ? severity : 'low') as Finding['severity'],
      category: categorize(title),
      scope: d.siteWide || !urls.length ? 'site' : 'page',
      occurrences: Number(d.count ?? examples.length ?? 1) || 1,
      pagesTotal: d.siteWide?.totalPages ?? (urls.length ? scanQuality.pagesOk : null),
      examples: examples.slice(0, 3).map(plain),
    });
  }
  const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity] || b.occurrences - a.occurrences);
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  const byCategory: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity]++;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  }

  // ── Scores and recommendations ─────────────────────────────────────────────
  const summary = (analysis.summary ?? {}) as Json;
  const perfSource = (summary.performanceSource as string | undefined) ?? (metadata.crawlProfile?.perf ? 'lab' : null);
  const scores = [
    { category: 'overall', score: blocked ? null : (summary.overallScore ?? null), source: null },
    ...Object.entries((summary.categoryScores ?? {}) as Record<string, number>).map(([category, score]) => ({
      category,
      score: blocked ? null : Math.round(score),
      source:
        category === 'performance' && ['lab', 'field', 'findings'].includes(String(perfSource))
          ? (perfSource as 'lab' | 'field' | 'findings')
          : null,
    })),
  ];
  const quickWins = (summary.quickWins ?? []) as Json[];
  const recommendations = quickWins.map((q, i) => ({
    rank: i + 1,
    title: plain(String(q.issue ?? '')),
    codes: [deriveCode(String(q.issue ?? '')).code],
    impact: q.impact ?? null,
    effort: q.effort ?? null,
    quickWin: true,
    fix: q.fix ?? null,
    pagesAffected: typeof q.affectedPages === 'number' ? q.affectedPages : null,
  }));

  // ── Site profile ───────────────────────────────────────────────────────────
  const okPages = pages.filter((p) => !blockedUrls.has(p.url) && (p.status ?? 200) < 300 && !p.redirectOnly);
  const languages = [
    ...new Set(
      okPages
        .map((p) => p.languageDetection?.htmlLang ?? p.internationalSEO?.langAttribute)
        .filter(Boolean)
        .map((l: string) => l.toLowerCase()),
    ),
  ];
  const ua = (metadata.robots?.['user-agent'] ?? {}) as Record<string, Json>;
  const aiCrawlerRules = Object.fromEntries(
    AI_CRAWLERS.map((bot) => {
      const rule = Object.entries(ua).find(([k]) => k.toLowerCase() === bot.toLowerCase())?.[1];
      return [bot, !rule ? 'not set' : (rule.disallow ?? []).includes('/') ? 'disallowed' : 'allowed'];
    }),
  );
  const titles = Object.keys(details).join('\n');
  const llmsTxt = /llms\.txt is missing/i.test(titles)
    ? 'missing'
    : /llms\.txt.*(invalid|malformed)/i.test(titles)
      ? 'invalid'
      : 'valid';
  const schemaTypes = [
    ...new Set(
      okPages
        .flatMap((p) => ((p.structuredData?.jsonLdSchemas ?? []) as Json[]).map((s) => s.type).filter(Boolean))
        .flat()
        .map(String),
    ),
  ].slice(0, 100);
  const sec = homePage?.security ?? {};
  const present = Object.keys(sec.headers ?? {});
  const forms = okPages.filter((p) => (p.formData?.formCount ?? 0) > 0);
  const ctas = ((homePage?.ctaData?.ctas ?? homePage?.ctas ?? []) as Json[])
    .slice(0, 20)
    .map((c) => ({ text: String(c.text ?? '').slice(0, 120), href: c.href ?? null, aboveFold: c.aboveFold ?? null }));
  const bookingLinks = [
    ...new Set(
      okPages.flatMap((p) =>
        ((p.links ?? []) as unknown[])
          .map((l) => (typeof l === 'string' ? l : (l as Json)?.href))
          .filter((h): h is string => typeof h === 'string' && BOOKING.test(h)),
      ),
    ),
  ].slice(0, 20);
  const evidence = (manifest.evidence ?? {}) as Record<string, { url?: string; files?: string[] }>;
  const homeShot = Object.entries(evidence).find(([, e]) => e.url === keyUrl || e.url === home);
  const shotFile =
    homeShot?.[1].files?.find((f) => f === 'screenshot.desktop.png') ??
    homeShot?.[1].files?.find((f) => /^screenshot\..*\.png$/.test(f));

  // ── Field metrics ──────────────────────────────────────────────────────────
  const crux = metadata.cruxData as Json | null | undefined;
  const p75 = (k: string) => {
    const v = crux?.metrics?.[k]?.percentiles?.p75;
    return v === undefined || v === null ? null : Number(v);
  };
  const fieldMetrics = crux?.metrics
    ? [
        {
          scope: (crux.targetType === 'url' ? 'url' : 'origin') as 'url' | 'origin',
          url: crux.target ?? null,
          formFactor: String(crux.formFactor ?? 'ALL'),
          lcpP75: p75('LCP') === null ? null : Math.round(p75('LCP')!),
          clsP75: p75('CLS'),
          inpP75: p75('INP') === null ? null : Math.round(p75('INP')!),
          ttfbP75: p75('TTFB') === null ? null : Math.round(p75('TTFB')!),
          fcpP75: p75('FCP') === null ? null : Math.round(p75('FCP')!),
        },
      ]
    : [];

  // ── Stack, vendors, tracking IDs ───────────────────────────────────────────
  const fp = input.stack ?? readJson(path.join(runDir, 'platform', 'stack.json'));
  const profile = fp?.profile as Json | undefined;
  const techs = new Map<
    string,
    {
      name: string;
      kind: string;
      version: string | null;
      confidence: string | null;
      eolDate: string | null;
      evidence: unknown;
    }
  >();
  const addTech = (
    name: string | null | undefined,
    kind: string,
    version: string | null = null,
    confidence: string | null = null,
    evidence: unknown = null,
  ) => {
    if (!name) return;
    const key = name.toLowerCase();
    const cur = techs.get(key);
    if (cur) {
      cur.version ??= version;
      return;
    }
    techs.set(key, { name, kind, version, confidence, eolDate: null, evidence });
  };
  if (profile) {
    addTech(
      profile.cms,
      'cms',
      profile.cmsVersion ?? null,
      profile.confidence ?? null,
      (profile.signals ?? []).filter((s: Json) => s.tech === profile.cms),
    );
    addTech(profile.cmsSecondary, 'cms');
    addTech(profile.framework, 'framework', profile.frameworkVersion ?? null, profile.confidence ?? null);
    for (const part of String(profile.runtime ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const [name, ...v] = part.split(' ');
      addTech(name!, vendorKind(name!) === 'other' ? 'runtime' : vendorKind(name!), v.join(' ') || null);
    }
    for (const l of (profile.libraries ?? []) as Json[]) addTech(l.name, 'library', l.version ?? null);
    for (const e of (profile.eol ?? []) as Json[]) {
      const t =
        techs.get(String(e.product ?? e.label).toLowerCase()) ??
        [...techs.values()].find((x) => x.name.toLowerCase() === String(e.label).toLowerCase());
      if (t) t.eolDate = e.eolDate ?? null;
      else
        techs.set(String(e.label).toLowerCase(), {
          name: e.label,
          kind: vendorKind(e.label),
          version: e.version ?? null,
          confidence: null,
          eolDate: e.eolDate ?? null,
          evidence: { cycle: e.cycle },
        });
    }
  }
  for (const p of okPages.slice(0, 50)) {
    for (const t of (p.technologies?.technologies ?? []) as Json[]) {
      const cat = String(t.category ?? '').toLowerCase();
      const kind = cat.includes('cms')
        ? 'cms'
        : cat.includes('framework')
          ? 'framework'
          : cat.includes('analytics')
            ? 'analytics'
            : cat.includes('tag manager')
              ? 'tag_manager'
              : vendorKind(t.name);
      addTech(t.name, kind, t.version ?? null, t.confidence ?? null);
    }
  }
  if (homePage?.caching?.cdnProvider) addTech(homePage.caching.cdnProvider, 'cdn');
  const consent = okPages.map((p) => p.consentData?.consentPlatform).find(Boolean);
  if (consent) addTech(consent, 'consent');
  const tracking = new Map<
    string,
    {
      kind: 'ga4' | 'gtm' | 'meta_pixel' | 'ua' | 'ads' | 'other';
      value: string;
      pagesSeen: number;
      sendsHits: boolean | null;
    }
  >();
  const addId = (kind: 'ga4' | 'gtm' | 'meta_pixel' | 'ua' | 'ads' | 'other', value: string, hits: boolean | null) => {
    const k = `${kind}:${value}`;
    const cur = tracking.get(k) ?? { kind, value, pagesSeen: 0, sendsHits: null };
    cur.pagesSeen++;
    if (hits !== null) cur.sendsHits = (cur.sendsHits ?? false) || hits;
    tracking.set(k, cur);
  };
  for (const p of okPages) {
    const tr = p.tagRuntime ?? {};
    const ids = p.analytics?.trackingIds ?? {};
    const hitIds = new Set<string>(((tr.ga4Ids ?? []) as string[]).filter(() => (tr.hits ?? 0) > 0));
    for (const id of new Set<string>([...(ids.ga4 ?? []), ...(tr.ga4Ids ?? [])])) addId('ga4', id, hitIds.has(id));
    for (const id of new Set<string>([...(ids.gtm ?? []), ...(tr.gtmIds ?? [])])) addId('gtm', id, null);
    for (const id of new Set<string>([...(ids.fbPixel ?? []), ...(tr.metaPixelIds ?? [])]))
      addId('meta_pixel', id, null);
    for (const id of new Set<string>(ids.ua ?? [])) addId('ua', id, null);
  }
  if ([...tracking.values()].some((t) => t.kind === 'ga4')) addTech('Google Analytics', 'analytics');
  if ([...tracking.values()].some((t) => t.kind === 'gtm')) addTech('Google Tag Manager', 'tag_manager');
  if ([...tracking.values()].some((t) => t.kind === 'meta_pixel')) addTech('Meta Pixel', 'ads');

  // ── Lead gate runs ─────────────────────────────────────────────────────────
  const gateDir = path.join(runDir, 'lead', 'gate-runs');
  const gateFiles = existsSync(gateDir)
    ? readdirSync(gateDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : [];
  const gateRuns = gateFiles
    .map((f) => readJson(path.join(gateDir, f)))
    .filter((l): l is Json => !!l && typeof l.checkedAt === 'string')
    .map((l) => ({
      runAt: l.rerankedAt ?? l.checkedAt,
      source: input.gateSource ?? ('workflow' as const),
      teaserReady: !!l.teaserReady,
      facts: ((l.highlights ?? []) as Json[]).map((h) => ({
        type: String(h.type),
        rootCause: String(h.rootCause ?? h.type),
        weight: (['heavy', 'medium', 'light'].includes(h.weight) ? h.weight : 'light') as 'heavy' | 'medium' | 'light',
        fact: String(h.fact ?? ''),
        url: h.url ?? null,
        gate: 'pass' as const,
        dependsOn: factDependsOn(String(h.type)),
        evidence: h.evidence ?? {},
      })),
      candidatesDropped: (l.candidatesDropped ?? []) as unknown[],
      previous: l.previous ?? null,
      disclosure: (l.disclosure ?? []) as unknown[],
    }));

  // ── Disclosures (standard profile): leaked keys and takeover candidates ────
  const disclosures: Array<{ code: string; target: string }> = [];
  if (input.profile !== 'public') {
    for (const c of checks.filter(
      (c) => (c.id === 'js-secrets' || c.id === 'subdomain-takeover') && c.status === 'fail',
    )) {
      const rows = Array.isArray(c.details) && c.details.length ? (c.details as Json[]) : [{}];
      for (const r of rows)
        disclosures.push({
          code: c.id,
          target: String(r.url ?? r.host ?? r.target ?? r.script ?? domain).slice(0, 500),
        });
    }
    for (const g of gateRuns.at(-1)?.disclosure ?? []) {
      const d = g as Json;
      disclosures.push({
        code: String(d.check ?? d.code ?? 'disclosure'),
        target: String(d.target ?? d.url ?? domain).slice(0, 500),
      });
    }
  }

  const ls = metadata.leadScan as Json | undefined;
  const doc = {
    modelVersion: MODEL_VERSION,
    audit: {
      mode,
      targetUrl: keyUrl,
      domain,
      runFolder: `${path.basename(path.dirname(runDir))}/${path.basename(runDir)}`,
      startedAt: metadata.timing?.startTime ?? null,
      finishedAt: metadata.timing?.endTime ?? null,
      elapsedMs: typeof metadata.timing?.elapsedTime === 'number' ? metadata.timing.elapsedTime : null,
      passive: !!metadata.passive,
      profile: input.profile ?? null,
      preset: input.preset ?? metadata.preset ?? null,
      perf: !!metadata.crawlProfile?.perf,
      visual: !!metadata.visual,
    },
    scanQuality,
    scores,
    counts: { total: findings.length, bySeverity, byCategory },
    findings,
    recommendations,
    siteChecks: checks.map((c) => ({
      checkId: String(c.id),
      label: String(c.label ?? c.id),
      status: String(c.status ?? ''),
      note: c.note ?? null,
      details: c.details ?? null,
    })),
    siteProfile: {
      languages,
      multilang: typeof metadata.isMultiLang === 'boolean' ? metadata.isMultiLang : languages.length > 1,
      aiCrawlerRules,
      llmsTxt,
      schemaTypes,
      httpVersion:
        homePage?.protocolData?.protocolVersion ??
        (homePage?.protocolData?.protocol && homePage.protocolData.protocol !== 'unknown'
          ? homePage.protocolData.protocol
          : null),
      cdn: homePage?.caching?.cdnProvider ?? null,
      securityHeaders: present,
      hasContactForm: okPages.length ? forms.length > 0 : null,
      formProviders: [],
      ctas,
      bookingLinks,
      homepageScreenshot: homeShot && shotFile ? `evidence/${homeShot[0]}/${shotFile}` : null,
    },
    fieldMetrics,
    robots: { sitemaps: (metadata.robots?.sitemaps ?? []) as string[], userAgents: Object.keys(ua) },
    sitemaps: { total: typeof metadata.sitemaps?.total === 'number' ? metadata.sitemaps.total : null },
    pages: { crawled: pages.length, ok: okPages.length },
    leadScan: ls
      ? {
          cap: ls.cap ?? null,
          selected: ((ls.selected ?? []) as Json[]).map((s) => ({ url: String(s.url), reason: s.reason ?? null })),
          requests: ls.requests?.total ?? null,
        }
      : null,
    stack:
      profile || techs.size || tracking.size
        ? {
            kind: profile?.kind ?? null,
            confidence: profile?.confidence ?? null,
            technologies: blocked && !scanQuality.homepageRead ? [] : [...techs.values()],
            trackingIds: [...tracking.values()],
          }
        : null,
    gateRuns,
    disclosures,
  };
  return SiteDocument.parse(doc);
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const intOrNull = (v: unknown): number | null => (num(v) === null ? null : Math.round(v as number));
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The row parts the report needs: run-level data and one record per page (design §2). */
export function buildRowParts(runDir: string): { runData: RunData; pages: PageRecord[] } {
  const manifest = readGz(path.join(runDir, 'manifest.json.gz'));
  if (!manifest) throw new Error(`not a run folder: ${runDir}`);
  const metadata = readGz(path.join(runDir, 'metadata.json.gz')) ?? {};
  const analysis = readGz(path.join(runDir, 'analysis.json.gz')) ?? {};
  const incoming = readGz(path.join(runDir, 'incoming-links.json.gz')) ?? {};
  const blocked = new Set<string>();
  for (const [key, urls] of Object.entries((manifest.progress?.byError ?? {}) as Record<string, unknown>)) {
    if (/^(challenge-)?(401|403|429|503)$/.test(key) && Array.isArray(urls))
      urls.forEach((u) => typeof u === 'string' && blocked.add(u));
  }
  const reasons = new Map<string, string>(
    ((metadata.leadScan?.selected ?? []) as Json[]).map((s) => [String(s.url), String(s.reason ?? '')]),
  );
  const pages = loadRunPages(runDir, manifest).map((p) =>
    PageRecord.parse({
      url: String(p.url),
      finalUrl: str(p.finalUrl),
      statusCode: intOrNull(p.status),
      blocked: blocked.has(p.url) || [401, 403, 429].includes(Number(p.status)),
      segment: str(p.segment),
      title: str(p.title),
      metaDescription: str(p.description),
      canonical: str(p.canonical),
      h1: Array.isArray(p.headings?.h1) ? p.headings.h1.map(String) : [],
      lang: str(p.languageDetection?.htmlLang ?? p.internationalSEO?.langAttribute),
      indexable: typeof p.indexability?.isIndexable === 'boolean' ? p.indexability.isIndexable : null,
      inSitemap: p.foundIn ? p.foundIn === 'sitemap' : null,
      wordCount: intOrNull(p.contentQuality?.wordCount),
      schemaTypes: ((p.structuredData?.jsonLdSchemas ?? []) as Json[]).map((x) => String(x.type ?? '')).filter(Boolean),
      ttfbMs: intOrNull(p.TTFB ?? p.ttfb),
      lcpMs: intOrNull(p.LCP ?? p.lcp),
      cls: num(p.CLS ?? p.cls),
      fcpMs: intOrNull(p.FCP ?? p.fcp),
      inpMs: intOrNull(p.INP ?? p.inp),
      tbtMs: intOrNull(p.TBT ?? p.tbt),
      bytes: intOrNull(p.totalResponseSize),
      requests: intOrNull(p.totalNumberOfRequests),
      selectionReason: reasons.get(p.url) || null,
      sections: p,
    }),
  );
  return { runData: { manifest, metadata, analysis, 'incoming-links': incoming }, pages };
}

/** Writes model/site.json.gz, model/run-data.json.gz, model/pages-NNNN.ndjson.gz and model/raw-archive.tar.gz. */
export function writeAuditModel(input: BuildInput): { doc: SiteDocument; sitePath: string; archivePath: string } {
  const doc = buildAuditModel(input);
  const dir = path.join(input.runDir, 'model');
  mkdirSync(dir, { recursive: true });
  const sitePath = path.join(dir, 'site.json.gz');
  writeFileSync(sitePath, gzipSync(JSON.stringify(doc)));
  const rows = buildRowParts(input.runDir);
  writeFileSync(path.join(dir, 'run-data.json.gz'), gzipSync(JSON.stringify(rows.runData)));
  for (let i = 0; i * PAGE_CHUNK_SIZE < rows.pages.length; i++) {
    const chunk = rows.pages.slice(i * PAGE_CHUNK_SIZE, (i + 1) * PAGE_CHUNK_SIZE);
    writeFileSync(
      path.join(dir, `pages-${String(i + 1).padStart(4, '0')}.ndjson.gz`),
      gzipSync(chunk.map((r) => JSON.stringify(r)).join('\n')),
    );
  }
  const archivePath = path.join(dir, 'raw-archive.tar.gz');
  writeRawArchive(input.runDir, archivePath);
  return { doc, sitePath, archivePath };
}

/** The run's raw files (*.json.gz, pages/, reports as text, lead/*.json) without screenshots and evidence. */
export function writeRawArchive(runDir: string, archivePath: string): void {
  const include: string[] = [];
  for (const name of readdirSync(runDir)) {
    if (name === 'model' || name === 'evidence') continue;
    if (name === 'pages' || /\.(json\.gz|json|md|html|csv|svg)$/.test(name)) include.push(name);
  }
  if (existsSync(path.join(runDir, 'lead', 'lead.json'))) include.push('lead/lead.json');
  if (existsSync(path.join(runDir, 'lead', 'gate-runs'))) include.push('lead/gate-runs');
  if (existsSync(path.join(runDir, 'platform'))) include.push('platform');
  execFileSync('tar', ['-czf', archivePath, '-C', runDir, ...include]);
}
