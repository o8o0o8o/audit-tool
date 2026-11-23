/**
 * What an MCP answer costs its reader. An assistant pays for every character of every tool answer
 * (and of every tool definition, once per session), so the MCP layer sends what a caller needs to
 * decide its next step and no more: no indentation, no second copy of the answer, no empty fields,
 * small pages by default, and the long lists only on request. The core functions are unchanged: the
 * internal pages and the pipeline's REST routes still get everything.
 */
import type { LeadSummaryRow } from '@model/lead-summary';

/**
 * Leaves out what says nothing: null, undefined, empty strings, empty arrays and empty objects.
 * `false` and `0` are kept, they are answers. The server's instructions tell the reader that a
 * missing field means "none".
 */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => compact(v)) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const c = compact(v);
      if (c === null || c === undefined || c === '') continue;
      if (Array.isArray(c) && c.length === 0) continue;
      if (typeof c === 'object' && !(c instanceof Date) && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out as T;
  }
  return value;
}

/** A safety net, not a page size: the lists below are sized so that a normal answer is far under it. */
export const MAX_ANSWER_CHARS = 60_000;

/** The text of a tool answer: compact JSON, cut with a plain note when a caller asked for too much. */
export function answerText(data: unknown): string {
  // The answer's own fields always appear, so a list that found nothing is `[]` and a missing row
  // is `null`; inside them, empty fields are left out.
  const top =
    data && typeof data === 'object' && !Array.isArray(data)
      ? Object.fromEntries(
          Object.entries(data as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, compact(v)]),
        )
      : compact(data);
  const text = JSON.stringify(top);
  if (text.length <= MAX_ANSWER_CHARS) return text;
  return JSON.stringify({
    truncated: true,
    note: `The answer was ${text.length} characters and is cut at ${MAX_ANSWER_CHARS}. Ask for less: a smaller limit, a filter, or the next page.`,
    data: text.slice(0, MAX_ANSWER_CHARS),
  });
}

const REPORT_KIND = /^(report_|content_research_|teaser_)/;

/**
 * `get_audit` for an assistant: the reports it can open (by kind) and a count of the other stored
 * files, in place of one row per file (a full audit stores hundreds).
 */
export function slimAudit<T extends { artifacts: { kind: string }[] }>(view: T) {
  const { artifacts, links: _links, ...rest } = view as T & { links?: unknown };
  const others: Record<string, number> = {};
  for (const f of artifacts) if (!REPORT_KIND.test(f.kind)) others[f.kind] = (others[f.kind] ?? 0) + 1;
  return {
    ...rest,
    reports: [...new Set(artifacts.filter((f) => REPORT_KIND.test(f.kind)).map((f) => f.kind))],
    other_files: others,
  };
}

/** A row of `list_audits`: what tells audits apart. `get_audit` has the rest. */
export function slimAuditRow(r: Record<string, unknown>) {
  const { legacy_run_id: _l, preset, target_url, domain, mode, created_at, finished_at, ...rest } = r;
  const minute = (v: unknown) => (typeof v === 'string' ? v.slice(0, 16) : v);
  return {
    ...rest,
    domain,
    mode,
    created_at: minute(created_at),
    finished_at: minute(finished_at),
    // The address only where it says more than the domain: a single-page audit.
    ...(mode === 'page' ? { target_url } : {}),
    ...(preset ? { preset } : {}),
  };
}

/** The short row of `list_lead_summaries`: enough to pick sites; `get_lead_summary` has the detail. */
export function shortLeadRow(r: LeadSummaryRow) {
  return {
    audit_id: r.audit_id,
    domain: r.domain,
    mode: r.mode,
    scanned_at: r.scanned_at?.slice(0, 10) ?? null,
    scan_quality: r.scan_quality,
    outreach_blocked: r.outreach_blocked,
    teaser_ready: r.facts.teaser_ready,
    score: r.scores.overall,
    issues: { critical: r.issues.critical, high: r.issues.high, total: r.issues.total },
    facts: { heavy: r.facts.heavy, medium: r.facts.medium, light: r.facts.light },
    top_fact: r.facts.top[0]?.fact ?? null,
    cms: r.stack.cms,
    framework: r.stack.framework,
    cwv_pass: r.field_speed.cwv_pass,
    prospect_stage: r.prospect?.stage ?? null,
  };
}

/** Site-check details can list hundreds of hosts or files: the first few and how many there are. */
export function capDetails(details: unknown, max = 5): { details?: unknown; details_total?: number } {
  if (!Array.isArray(details)) return details === null || details === undefined ? {} : { details };
  if (details.length <= max) return { details };
  return { details: details.slice(0, max), details_total: details.length };
}

/** Sent once per session with the tool list: how to read the answers and how not to waste calls. */
export const SERVER_INSTRUCTIONS = [
  'Website audits: start them, wait for them, read their results.',
  'Answers are compact JSON. Inside a row, a field that is null or empty is left out: a missing field means "none" or "not known".',
  'Lists are short by default. Use the filters and `limit` to get what you need rather than everything; follow `next_cursor` only when the user needs more.',
  'To wait for an audit, call wait_for_audit once with timeout_seconds=280; do not poll get_audit or list_audits.',
  'For many sites use list_lead_summaries (short rows), then get_lead_summary for the one or two that matter.',
].join(' ');
