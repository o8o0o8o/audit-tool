import type { Section } from './phase2/categorize';

export const SPEED_PRESETS = ['quick', 'standard', 'deep'] as const;
export const ROLE_PRESETS = ['sales', 'marketing', 'seo', 'custom'] as const;
export const PRESET_NAMES = [...SPEED_PRESETS, ...ROLE_PRESETS] as const;

export type PresetName = (typeof PRESET_NAMES)[number];
export type RolePreset = (typeof ROLE_PRESETS)[number];

/** Report sections a role preset or `--sections` can select, in canonical order. */
export const REPORT_SECTIONS = [
  'executive-summary',
  'technology-stack',
  'cta',
  'top-issues',
  'performance',
  'seo',
  'privacy',
  'accessibility',
  'ux',
  'technical',
  'charts',
  'content-insights',
  'pages',
  'source-code',
  'history',
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

/** Finding groups (analyzer families) `--checks` can select. All analyzers still run at crawl time. */
export const CHECK_NAMES = [
  'performance',
  'seo',
  'accessibility',
  'security',
  'privacy',
  'ux',
  'technical',
  'content',
  'cta',
  'technology',
  'analytics',
  'visual',
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export type HtmlSectionId =
  | 'executive-summary'
  | 'issues-detail'
  | 'performance'
  | 'charts'
  | 'content-insights'
  | 'technology-stack'
  | 'pages-table'
  | 'source-code'
  | 'history';

const SECTION_TARGETS: Record<ReportSection, { html?: HtmlSectionId; phase2?: Section }> = {
  'executive-summary': { html: 'executive-summary' },
  'technology-stack': { html: 'technology-stack' },
  cta: { html: 'content-insights', phase2: 'ux' },
  'top-issues': { html: 'issues-detail' },
  performance: { html: 'performance', phase2: 'performance' },
  seo: { phase2: 'seo' },
  privacy: { phase2: 'privacy' },
  accessibility: { phase2: 'accessibility' },
  ux: { phase2: 'ux' },
  technical: { phase2: 'technical' },
  charts: { html: 'charts' },
  'content-insights': { html: 'content-insights' },
  pages: { html: 'pages-table' },
  'source-code': { html: 'source-code' },
  history: { html: 'history' },
};

export interface PresetRunOptions {
  perf?: boolean;
  saveHtml?: boolean;
  limit?: number;
  concurrency?: number;
}

interface RoleDefinition {
  sections: readonly ReportSection[];
  checks?: readonly CheckName[];
  runOptions: PresetRunOptions;
}

export const ROLE_DEFINITIONS: Record<Exclude<RolePreset, 'custom'>, RoleDefinition> = {
  sales: {
    sections: ['executive-summary', 'technology-stack', 'cta', 'top-issues', 'performance', 'ux'],
    checks: ['performance', 'seo', 'ux', 'cta', 'technology'],
    runOptions: {},
  },
  marketing: {
    sections: ['executive-summary', 'top-issues', 'seo', 'content-insights', 'cta', 'ux', 'performance', 'privacy'],
    checks: ['seo', 'content', 'ux', 'cta', 'performance', 'privacy', 'analytics', 'visual'],
    runOptions: {},
  },
  seo: {
    sections: [
      'executive-summary',
      'top-issues',
      'seo',
      'technical',
      'performance',
      'accessibility',
      'content-insights',
      'charts',
      'pages',
    ],
    runOptions: {},
  },
};

export interface ResolvedPreset {
  preset: PresetName | null;
  runOptions: PresetRunOptions;
  /** Ordered selection; `undefined` ⇒ full report in default order. */
  sections?: ReportSection[];
  /** Finding groups to keep; `undefined` ⇒ no finding filter. */
  checks?: CheckName[];
  /** Phase 2 sections in render order; `undefined` ⇒ `SECTION_ORDER`. */
  phase2Sections?: Section[];
  /** HTML report sections in render order; `undefined` ⇒ every section. */
  htmlSections?: HtmlSectionId[];
}

export class PresetError extends Error {}

export function isPresetName(name: string): name is PresetName {
  return (PRESET_NAMES as readonly string[]).includes(name);
}

export function unknownPresetMessage(name: string): string {
  return `Unknown preset "${name}". Valid presets: ${PRESET_NAMES.join(', ')}.`;
}

function validateList<T extends string>(kind: string, values: readonly string[], valid: readonly T[]): T[] {
  const unknown = values.filter((v) => !(valid as readonly string[]).includes(v));
  if (unknown.length > 0) {
    throw new PresetError(`Unknown ${kind} "${unknown.join('", "')}". Valid ${kind}s: ${valid.join(', ')}.`);
  }
  return [...new Set(values)] as T[];
}

export function parseCsvList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function uniqueDefined<T>(values: Array<T | undefined>): T[] {
  return [...new Set(values.filter((v): v is T => v !== undefined))];
}

export function resolvePreset(
  name: string | null | undefined,
  selection: { sections?: readonly string[]; checks?: readonly string[] } = {},
): ResolvedPreset {
  const preset = name ? name.toLowerCase() : null;
  if (preset !== null && !isPresetName(preset)) throw new PresetError(unknownPresetMessage(preset));

  const hasSelection = (selection.sections?.length ?? 0) > 0 || (selection.checks?.length ?? 0) > 0;
  if (hasSelection && preset !== 'custom') {
    throw new PresetError('--sections and --checks are only valid with --preset=custom.');
  }

  let sections: ReportSection[] | undefined;
  let checks: CheckName[] | undefined;
  let runOptions: PresetRunOptions = {};

  if (preset === 'custom') {
    if (!hasSelection) {
      throw new PresetError('--preset=custom needs a selection: pass --sections=<csv> and/or --checks=<csv>.');
    }
    if (selection.sections?.length) sections = validateList('section', selection.sections, REPORT_SECTIONS);
    if (selection.checks?.length) checks = validateList('check', selection.checks, CHECK_NAMES);
  } else if (preset === 'sales' || preset === 'marketing' || preset === 'seo') {
    const def = ROLE_DEFINITIONS[preset];
    sections = [...def.sections];
    checks = def.checks ? [...def.checks] : undefined;
    runOptions = { ...def.runOptions };
  } else if (preset === 'quick') {
    runOptions = { concurrency: 10, limit: 50, perf: false };
  } else if (preset === 'deep') {
    runOptions = { concurrency: 3, perf: true, saveHtml: true };
  }

  return {
    preset,
    runOptions,
    sections,
    checks,
    phase2Sections: sections && uniqueDefined(sections.map((s) => SECTION_TARGETS[s].phase2)),
    htmlSections: sections && uniqueDefined(sections.map((s) => SECTION_TARGETS[s].html)),
  };
}

const PRESET_SUMMARIES: Partial<Record<PresetName, string>> = {
  quick: 'Quick preset: 50 pages max, no perf metrics, concurrency 10',
  deep: 'Deep preset: all pages, perf enabled, HTML snapshots, concurrency 3',
  sales: 'Sales preset: executive summary, tech stack, CTAs/conversion, top issues',
  marketing: 'Marketing preset: SEO, content, conversion, UX and privacy sections',
  seo: 'SEO preset: full technical SEO report',
  custom: 'Custom preset: report limited to the selected sections/checks',
};

/** Applies a preset's run options, leaving an explicit `--concurrency` / `--limit` untouched; returns a one-line summary to print. */
export function applyPresetRunOptions(
  args: { perf: boolean; saveHtml: boolean; limit: number | null; concurrency: number; concurrencyExplicit: boolean },
  resolved: ResolvedPreset,
): string | undefined {
  const { perf, saveHtml, limit, concurrency } = resolved.runOptions;
  if (concurrency !== undefined && !args.concurrencyExplicit) args.concurrency = concurrency;
  if (limit !== undefined) args.limit ??= limit;
  if (perf !== undefined) args.perf = perf;
  if (saveHtml) args.saveHtml = true;
  return resolved.preset ? PRESET_SUMMARIES[resolved.preset] : undefined;
}

const CHECK_KEYWORDS: ReadonlyArray<[CheckName, RegExp]> = [
  [
    'security',
    /\b(https?|security|csp|content-security|hsts|strict-transport|x-frame|sri|subresource|tls|ssl|mixed content|permissions-policy|cross-origin|server disclosure|x-powered-by)\b/i,
  ],
  ['content', /\b(content|word count|words|thin|readab|freshness|keyword|duplicate|heading|h1|h2)\b/i],
  ['cta', /\b(cta|call[- ]to[- ]action|conversion|form|button|tel:|mailto)\b/i],
  [
    'technology',
    /\b(framework|cms|technology|tech stack|x-powered-by|server header|wordpress|next\.?js|react|shopify)\b/i,
  ],
  ['analytics', /\b(analytics|ga4|gtm|tag manager|tracking|pixel)\b/i],
  [
    'visual',
    /\b(broken image|failed image|upscaled|template token|placeholder text|lorem|mojibake|garbled|clipped)/i,
  ],
];

/** Check groups a finding belongs to: its report section plus any keyword-matched families. */
export function findingCheckGroups(message: string, section: Section): CheckName[] {
  const groups: CheckName[] = [section];
  for (const [check, pattern] of CHECK_KEYWORDS) {
    if (pattern.test(message)) groups.push(check);
  }
  return groups;
}

/** True when the finding belongs to at least one selected check; no selection keeps everything. */
export function matchesChecks(message: string, section: Section, checks: readonly CheckName[] | undefined): boolean {
  if (!checks) return true;
  return findingCheckGroups(message, section).some((g) => checks.includes(g));
}

const AUDIT_TYPE_LABELS: Record<PresetName, string> = {
  quick: 'Quick',
  standard: 'Standard',
  deep: 'Deep',
  sales: 'Sales',
  marketing: 'Marketing',
  seo: 'SEO',
  custom: 'Custom',
};

/** Human label for the audit type a report was run with; no preset ⇒ "Full audit". */
export function auditTypeLabel(preset?: string | null): string {
  return preset && isPresetName(preset) ? AUDIT_TYPE_LABELS[preset] : 'Full audit';
}
