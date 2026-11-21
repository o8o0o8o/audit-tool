/**
 * What an audit runs with, shared by web/ (start_audit, the internal form) and the worker
 * (scripts/platform-worker.ts). Zod only. `toCliArgs` is the one place that turns options into
 * `start.ts` flags; web/lib/audit-options.ts and the workflow use it too.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Tool major version; part of `profile_hash`. A test keeps it equal to package.json. */
export const TOOL_MAJOR = 1;

export const AuditMode = z
  .enum(['full', 'quick', 'page'])
  .describe('full: whole site; quick: passive 25-page scan; page: one page');
export type AuditMode = z.infer<typeof AuditMode>;

export const AuditProfile = z.enum(['public', 'standard']);
export type AuditProfile = z.infer<typeof AuditProfile>;

export const RUN_PRESETS = ['quick', 'standard', 'deep', 'sales', 'marketing', 'seo', 'custom'] as const;

export const RunOptions = z
  .object({
    preset: z.enum(RUN_PRESETS).nullable().default(null).describe('Audit preset; null for none'),
    sections: z
      .array(z.string().regex(/^[a-z-]+$/))
      .default([])
      .describe('Report sections for the custom preset'),
    perf: z.boolean().default(false).describe('PageSpeed lab metrics (--perf)'),
    llm: z.boolean().default(false).describe('LLM passes (--llm); full audits only'),
    verify: z.boolean().default(false).describe('Phase 3 live verification (--verify)'),
    contentResearch: z.boolean().default(false).describe('Phase 4 content research (--content-research)'),
    visual: z.boolean().default(false).describe('UI defect checks (--visual)'),
    concurrency: z.number().int().min(1).max(20).nullable().default(null),
    limit: z.number().int().min(1).max(100000).nullable().default(null).describe('Max pages; full audits only'),
    maxPages: z
      .number()
      .int()
      .min(0)
      .max(100000)
      .nullable()
      .default(null)
      .describe('Page cap of a full audit (--max-pages): null for the default 5000, 0 for no cap'),
    evidenceCap: z.number().int().min(1).max(100).nullable().default(null),
    pdf: z.boolean().default(false).describe('Print PDFs of the reports (--pdf)'),
    passive: z.boolean().default(false).describe('Skip probes beyond reading published pages (--passive)'),
  })
  .strict();
export type RunOptions = z.infer<typeof RunOptions>;

/** Options that need `audits:start:full` beyond the mode itself. */
export const FULL_ONLY_OPTIONS = ['llm', 'verify', 'contentResearch'] as const;

/** Quick-scan settings, the same as LEAD_MODE in lib/args-parser.ts. */
export const QUICK_SCAN_SETTINGS = { pages: 25, concurrency: 3, evidenceCap: 5 } as const;

/** Mode-specific clean-up so equal requests give equal options (and so equal profile hashes). */
export function normalizeRunOptions(mode: AuditMode, raw: unknown): RunOptions {
  const o = RunOptions.parse(raw ?? {});
  if (o.preset !== 'custom') o.sections = [];
  if (mode === 'quick') {
    return {
      ...o,
      perf: false,
      llm: false,
      verify: false,
      contentResearch: false,
      visual: true,
      concurrency: null,
      limit: null,
      maxPages: null,
      evidenceCap: null,
      passive: true,
    };
  }
  if (mode === 'page') return { ...o, contentResearch: false, limit: null, maxPages: null };
  return o;
}

/** Steps the platform runs around the audit; part of `profile_hash`. */
export function platformSteps(mode: AuditMode, profile: AuditProfile): string[] {
  const steps = ['fingerprint'];
  if (mode === 'quick' && profile === 'standard') steps.push('gate');
  steps.push(profile === 'public' ? 'probes:public' : 'probes:standard');
  return steps;
}

const stableJson = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );

/** mode + options + steps run + tool major version (§4 "Audits"). */
export function profileHash(mode: AuditMode, profile: AuditProfile, options: RunOptions): string {
  // An unset page cap is left out, so audits stored before the option keep their hash.
  const { maxPages, ...rest } = options;
  const hashed = maxPages === null ? rest : options;
  const body = stableJson({ mode, profile, options: hashed, steps: platformSteps(mode, profile), tool: TOOL_MAJOR });
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
}

/** mode + preset + page limit + profile + check families on. Score trends compare only equal keys. */
export function comparableKey(mode: AuditMode, profile: AuditProfile, o: RunOptions): string {
  const families = [o.visual || mode === 'quick' ? 'visual' : null, 'agentic', o.perf ? 'perf' : null]
    .filter(Boolean)
    .join('+');
  return [
    mode,
    o.preset ?? 'none',
    `${o.limit ?? (mode === 'quick' ? QUICK_SCAN_SETTINGS.pages : 'all')}${o.maxPages !== null ? `/max${o.maxPages}` : ''}`,
    profile,
    families,
  ].join('|');
}

/** `start.ts` flags for an audit. `profile=public` adds `--profile=public` (skips secrets scan + takeover check). */
export function toCliArgs(input: {
  mode: AuditMode;
  url: string;
  profile: AuditProfile;
  options: RunOptions;
  proceed?: boolean;
}): string[] {
  const { mode, url, options: o } = input;
  const args = [mode === 'page' ? `--page=${url}` : `--origin=${url}`];
  if (mode === 'quick') args.push('--lead');
  else if (o.passive || input.profile === 'public') args.push('--passive');
  if (input.profile === 'public') args.push('--profile=public');
  if (o.preset) args.push(`--preset=${o.preset}`);
  if (o.sections.length) args.push(`--sections=${o.sections.join(',')}`);
  if (o.perf) args.push('--perf');
  if (o.llm) args.push('--llm');
  if (o.verify) args.push('--verify');
  if (o.contentResearch) args.push('--content-research');
  if (o.visual) args.push('--visual');
  if (o.concurrency) args.push(`--concurrency=${o.concurrency}`);
  if (o.limit) args.push(`--limit=${o.limit}`);
  if (o.maxPages !== null && mode === 'full') args.push(`--max-pages=${o.maxPages}`);
  if (o.evidenceCap) args.push(`--evidence-cap=${o.evidenceCap}`);
  if (o.pdf) args.push('--pdf');
  if (input.proceed) args.push('--proceed');
  return args;
}

/** Rough minutes, for `start_audit`'s `estimate_minutes`. */
export function estimateMinutes(mode: AuditMode, o: RunOptions): number {
  if (mode === 'quick') return 4;
  if (mode === 'page') return 2 + (o.perf ? 1 : 0) + (o.llm ? 2 : 0);
  const pages = o.limit ?? 100;
  return Math.max(
    3,
    Math.ceil((pages / (o.concurrency ?? 5)) * 0.2 * (o.perf ? 1.5 : 1)) +
      3 +
      (o.llm ? 5 : 0) +
      (o.contentResearch ? 10 : 0),
  );
}
