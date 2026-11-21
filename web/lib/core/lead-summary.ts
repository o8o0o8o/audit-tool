/**
 * `get_lead_summary` (task 4.4, design §5): a fixed shape, validated against the published schema.
 * Blocked scan: null scores, no quick wins or unverified findings, facts only where `depends_on`
 * allows (dns always, homepage when it was read, pages never); stack only when the homepage was read.
 */
import { and, arrayOverlaps, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  disclosures,
  findings,
  leadFacts,
  leadGateRuns,
  prospects,
  recommendations,
  scanQuality,
  scores,
  siteProfiles,
} from '../../db/schema';
import { LeadSummary } from '@model/lead-summary';
import { hasScope, type Principal } from './principal';
import { fieldMetricRows, getTechStack, resolveAudit } from './results';
import { registrableDomainOf } from './sites';

const WEIGHT = { heavy: 0, medium: 1, light: 2 } as const;
const SEV = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;

export async function getLeadSummary(db: Db, principal: Principal, raw: Record<string, unknown>): Promise<LeadSummary> {
  const { used, row } = await resolveAudit(db, principal, raw, { excludeModes: ['page'] });
  const [q] = await db.select().from(scanQuality).where(eq(scanQuality.auditId, used.audit_id));
  const state = (q?.state ?? 'ok') as 'ok' | 'partial' | 'blocked';
  const blocked = state === 'blocked';
  const homepageRead = q?.homepageRead ?? true;

  const [gate] = await db
    .select()
    .from(leadGateRuns)
    .where(eq(leadGateRuns.auditId, used.audit_id))
    .orderBy(desc(leadGateRuns.runAt))
    .limit(1);
  let facts = gate
    ? await db
        .select()
        .from(leadFacts)
        .where(and(eq(leadFacts.gateRunId, gate.id), eq(leadFacts.gate, 'pass')))
    : [];
  if (blocked) facts = facts.filter((f) => f.dependsOn === 'dns' || (f.dependsOn === 'homepage' && homepageRead));
  facts.sort((a, b) => WEIGHT[a.weight as keyof typeof WEIGHT] - WEIGHT[b.weight as keyof typeof WEIGHT]);

  const [open] = await db
    .select({ status: disclosures.status, createdAt: disclosures.createdAt })
    .from(disclosures)
    .where(and(eq(disclosures.siteId, row.siteId), eq(disclosures.status, 'open')))
    .orderBy(asc(disclosures.createdAt))
    .limit(1);

  const topFindings = blocked
    ? []
    : (await db.select().from(findings).where(eq(findings.auditId, used.audit_id)))
        .sort((a, b) => (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9) || b.occurrences - a.occurrences)
        .slice(0, 10);
  const wins = blocked
    ? []
    : await db
        .select()
        .from(recommendations)
        .where(eq(recommendations.auditId, used.audit_id))
        .orderBy(asc(recommendations.rank))
        .limit(3);
  const stack = await getTechStack(db, principal, { audit_id: used.audit_id });
  const showStack = !blocked || homepageRead;
  const vendors: Record<string, string[]> = {};
  if (showStack) for (const t of stack.technologies) (vendors[t.kind] ??= []).push(t.name);
  const [profile] = await db.select().from(siteProfiles).where(eq(siteProfiles.auditId, used.audit_id));
  const scoreRows = await db.select().from(scores).where(eq(scores.auditId, used.audit_id));
  const counts: Record<string, number> = {};
  for (const f of await db
    .select({ category: findings.category })
    .from(findings)
    .where(eq(findings.auditId, used.audit_id)))
    counts[f.category] = (counts[f.category] ?? 0) + 1;
  const fm = await fieldMetricRows(db, used.audit_id);
  let prospect = null;
  if (hasScope(principal, 'prospects:read')) {
    const [p] = await db
      .select()
      .from(prospects)
      .where(arrayOverlaps(prospects.registrableDomains, [registrableDomainOf(used.domain)]))
      .limit(1);
    if (p) prospect = { company: p.company, stage: p.stage, fit_score: p.fitScore, do_not_contact: p.doNotContact };
  }
  const summary = {
    audit_id: used.audit_id,
    mode: used.mode as 'full' | 'quick' | 'page',
    scanned_at: used.scanned_at,
    domain: used.domain,
    scan_quality: {
      state,
      reasons: q?.reasons ?? [],
      pages_read: q?.pagesOk ?? 0,
      pages_blocked: q?.pagesBlocked ?? 0,
    },
    outreach_blocked: !!open,
    disclosure: open ? { status: open.status, since: open.createdAt.toISOString() } : null,
    facts: facts.map((f) => ({
      type: f.type,
      rootCause: f.rootCause,
      weight: f.weight as 'heavy' | 'medium' | 'light',
      fact: f.fact,
      url: f.url,
      gate: f.gate as 'pass',
      dependsOn: f.dependsOn as 'pages' | 'homepage' | 'dns',
      evidence: f.evidence,
    })),
    gate_run_at: gate?.runAt.toISOString() ?? null,
    teaser_ready: !!gate?.teaserReady && !open,
    unverified_findings: topFindings.map((f) => ({
      code: f.code,
      title: f.title,
      severity: f.severity,
      occurrences: f.occurrences,
    })),
    quick_wins: wins.map((w) => ({ title: w.title, impact: w.impact, effort: w.effort })),
    stack: showStack
      ? stack.technologies.map((t) => ({
          name: t.name,
          kind: t.kind,
          version: t.version,
          confidence: t.confidence,
          eolDate: t.eol_date,
          evidence: null,
        }))
      : [],
    vendors,
    tracking_ids: stack.tracking_ids.map((t) => ({
      kind: t.kind as 'ga4',
      value: t.value,
      pagesSeen: t.pages_seen,
      sendsHits: t.sends_hits,
    })),
    site_profile: {
      languages: profile?.languages ?? [],
      has_contact_form: profile?.hasContactForm ?? null,
      booking_links: profile?.bookingLinks ?? [],
      ai_crawler_rules: (profile?.aiCrawlerRules as Record<string, string> | null) ?? null,
      llms_txt: profile?.llmsTxt ?? null,
    },
    scores: blocked ? null : Object.fromEntries(scoreRows.map((s) => [s.category, s.score])),
    field_metrics: fm.map((m) => ({
      scope: m.scope as 'origin' | 'url',
      url: m.url,
      formFactor: m.formFactor,
      lcpP75: m.lcpP75,
      clsP75: m.clsP75,
      inpP75: m.inpP75,
      ttfbP75: m.ttfbP75,
      fcpP75: m.fcpP75,
      pass:
        m.lcpP75 === null && m.clsP75 === null && m.inpP75 === null
          ? null
          : (m.lcpP75 ?? 0) <= 2500 && (m.clsP75 ?? 0) <= 0.1 && (m.inpP75 ?? 0) <= 200,
    })),
    counts,
    links: {
      report: `/internal/audits/${used.audit_id}`,
      homepage_screenshot: profile?.homepageScreenshotArtifactId
        ? `/internal/audits/${used.audit_id}/a/${profile.homepageScreenshotArtifactId}`
        : null,
    },
    prospect,
  };
  return LeadSummary.parse(summary);
}
