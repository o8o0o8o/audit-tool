/** Mirrors ROLE_PRESETS / REPORT_SECTIONS in lib/presets.ts (tests assert they stay equal). */
export const WEB_PRESETS = ['sales', 'marketing', 'seo', 'custom'] as const;
export type WebPreset = (typeof WEB_PRESETS)[number];
export const WEB_REPORT_SECTIONS = [
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

export interface AuditOptions {
  url: string;
  /** `null` runs the full audit with no preset. */
  preset: WebPreset | null;
  /** Report sections for the `custom` preset; empty otherwise. */
  sections: string[];
  perf: boolean;
  llm: boolean;
  verify: boolean;
  contentResearch: boolean;
  concurrency: number;
  limit: number | null;
  evidenceCap: number;
}

export type ParseResult = { ok: true; options: AuditOptions } | { ok: false; errors: string[] };

export type WorkflowInputs = Record<string, string>;

export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;

export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 20;
export const CONCURRENCY_DEFAULT = 5;
export const EVIDENCE_CAP_MIN = 1;
export const EVIDENCE_CAP_MAX = 100;
export const EVIDENCE_CAP_DEFAULT = 10;
export const LIMIT_MAX = 100000;

// Cheap syntactic guard against obvious internal targets, NOT complete SSRF protection: names that
// resolve to private addresses get through. The crawler's own isFetchAllowed is the real check.
function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::' || host === '0.0.0.0') return true;
  if (host.includes(':')) {
    // IPv6: unique-local fc00::/7, link-local fe80::/10, IPv4-mapped ::ffff:*
    return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host) || host.startsWith('::ffff:');
  }
  const octets = host.split('.');
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o))) return false;
  const [a, b] = octets.map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || a === 0 || (a === 100 && b >= 64 && b <= 127);
}

function parseUrl(raw: unknown, errors: string[]): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    errors.push('url is required');
    return '';
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    errors.push('url is not a valid URL');
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    errors.push('url must use http or https');
    return '';
  }
  if (isPrivateHostname(parsed.hostname)) {
    errors.push('url must not point at localhost or a private network');
    return '';
  }
  return parsed.origin;
}

function parseBool(raw: unknown): boolean {
  return raw === true || raw === 'true' || raw === 'on' || raw === '1';
}

function parsePreset(raw: unknown, errors: string[]): WebPreset | null {
  if (raw === undefined || raw === null || raw === '' || raw === 'full') return null;
  if (typeof raw === 'string' && (WEB_PRESETS as readonly string[]).includes(raw)) return raw as WebPreset;
  errors.push(`preset must be one of: full, ${WEB_PRESETS.join(', ')}`);
  return null;
}

function parseSections(raw: unknown, preset: WebPreset | null, errors: string[]): string[] {
  const list = raw === undefined || raw === null || raw === '' ? [] : Array.isArray(raw) ? raw : [raw];
  const known = WEB_REPORT_SECTIONS as readonly string[];
  const sections = [...new Set(list.map(String))];
  const unknown = sections.filter((s) => !known.includes(s));
  if (unknown.length > 0) errors.push(`unknown sections: ${unknown.join(', ')}`);
  if (preset !== 'custom') {
    if (sections.length > 0) errors.push('sections are only valid with the custom preset');
    return [];
  }
  if (sections.length === 0) errors.push('the custom preset needs at least one section');
  return known.filter((s) => sections.includes(s));
}

function parseInteger(raw: unknown, name: string, min: number, max: number, errors: string[]): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} must be an integer between ${min} and ${max}`);
    return null;
  }
  return value;
}

export function parseAuditRequest(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null) return { ok: false, errors: ['request body must be a JSON object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];
  const url = parseUrl(b.url, errors);
  const preset = parsePreset(b.preset, errors);
  const sections = parseSections(b.sections, preset, errors);
  const concurrency = parseInteger(b.concurrency, 'concurrency', CONCURRENCY_MIN, CONCURRENCY_MAX, errors);
  const limit = parseInteger(b.limit, 'limit', 1, LIMIT_MAX, errors);
  const evidenceCap = parseInteger(b.evidenceCap, 'evidenceCap', EVIDENCE_CAP_MIN, EVIDENCE_CAP_MAX, errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    options: {
      url,
      preset,
      sections,
      perf: parseBool(b.perf),
      llm: parseBool(b.llm),
      verify: parseBool(b.verify),
      contentResearch: parseBool(b.contentResearch),
      concurrency: concurrency ?? CONCURRENCY_DEFAULT,
      limit,
      evidenceCap: evidenceCap ?? EVIDENCE_CAP_DEFAULT,
    },
  };
}

export function isValidRunId(id: unknown): id is string {
  return typeof id === 'string' && RUN_ID_PATTERN.test(id);
}

export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15).toLowerCase();
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `${stamp}-${random}`;
}

export function toWorkflowInputs(opts: AuditOptions, runId: string): WorkflowInputs {
  return {
    url: opts.url,
    run_id: runId,
    preset: opts.preset ?? '',
    sections: opts.sections.join(','),
    perf: String(opts.perf),
    llm: String(opts.llm),
    verify: String(opts.verify),
    content_research: String(opts.contentResearch),
    concurrency: String(opts.concurrency),
    limit: opts.limit === null ? '' : String(opts.limit),
    evidence_cap: String(opts.evidenceCap),
  };
}

/** CLI flags for `start.ts`; `.github/workflows/audit.yml` builds the same list in shell. */
export function toCliArgs(inputs: WorkflowInputs): string[] {
  const args = [`--origin=${inputs.url}`];
  if (inputs.preset) args.push(`--preset=${inputs.preset}`);
  if (inputs.sections) args.push(`--sections=${inputs.sections}`);
  if (inputs.perf === 'true') args.push('--perf');
  if (inputs.llm === 'true') args.push('--llm');
  if (inputs.verify === 'true') args.push('--verify');
  if (inputs.content_research === 'true') args.push('--content-research');
  if (inputs.concurrency) args.push(`--concurrency=${inputs.concurrency}`);
  if (inputs.limit) args.push(`--limit=${inputs.limit}`);
  if (inputs.evidence_cap) args.push(`--evidence-cap=${inputs.evidence_cap}`);
  return args;
}

/** Page count assumed when no limit is set; the real crawl size is unknown until the sitemap is read. */
export const DEFAULT_ASSUMED_PAGES = 100;

export interface EstimateInput {
  url: string;
  preset: string | null;
  sections: string[];
  perf: boolean;
  llm: boolean;
  verify: boolean;
  contentResearch: boolean;
  concurrency: string | number | null;
  limit: string | number | null;
  evidenceCap: string | number | null;
}

export interface AuditEstimate {
  minutes: number;
  pages: number;
  assumedPages: boolean;
}

// Rough heuristics in seconds; there is no run history to calibrate against.
const SETUP_SECONDS = 30;
const REPORT_SECONDS = 60;
const BATCH_SECONDS = 12;
const PERF_BATCH_FACTOR = 1.5;
const EVIDENCE_SECONDS = 8;
const PSI_SECONDS = 20;
const VISION_SECONDS = 15;
const VERIFY_FIXED_SECONDS = 60;
const VERIFY_PER_PAGE_SECONDS = 1;
const LLM_SECONDS = 120;
const CONTENT_RESEARCH_SECONDS = 5 * 40 * 3;
const FULL_REPORT_SECONDS = 60;

function toPositiveInt(raw: string | number | null, fallback: number): number | null {
  if (raw === null || raw === '') return fallback;
  const value = Math.floor(Number(raw));
  return Number.isFinite(value) && value >= 1 ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Returns `null` when no meaningful estimate exists yet (no valid URL, or the form would be rejected). */
export function estimateAuditDuration(input: EstimateInput): AuditEstimate | null {
  const errors: string[] = [];
  parseUrl(input.url, errors);
  if (errors.length > 0) return null;
  if (input.preset === 'custom' && input.sections.length === 0) return null;

  const concurrency = clamp(toPositiveInt(input.concurrency, CONCURRENCY_DEFAULT) ?? CONCURRENCY_DEFAULT, CONCURRENCY_MIN, CONCURRENCY_MAX);
  const limit = toPositiveInt(input.limit, 0);
  const assumedPages = !limit;
  const pages = assumedPages ? DEFAULT_ASSUMED_PAGES : clamp(limit, 1, LIMIT_MAX);
  const evidenceCap = clamp(toPositiveInt(input.evidenceCap, EVIDENCE_CAP_DEFAULT) ?? EVIDENCE_CAP_DEFAULT, EVIDENCE_CAP_MIN, EVIDENCE_CAP_MAX);
  const samples = Math.min(evidenceCap, pages);

  let seconds = SETUP_SECONDS + REPORT_SECONDS;
  seconds += Math.ceil(pages / concurrency) * BATCH_SECONDS * (input.perf ? PERF_BATCH_FACTOR : 1);
  seconds += evidenceCap * EVIDENCE_SECONDS;
  if (input.perf) seconds += samples * PSI_SECONDS;
  if (input.llm) seconds += LLM_SECONDS + samples * VISION_SECONDS;
  if (input.verify) seconds += VERIFY_FIXED_SECONDS + pages * VERIFY_PER_PAGE_SECONDS;
  if (input.contentResearch) seconds += CONTENT_RESEARCH_SECONDS;
  if (!input.preset || input.preset === 'full' || input.preset === 'seo' || input.preset === 'custom') seconds += FULL_REPORT_SECONDS;

  return { minutes: Math.max(1, Math.ceil(seconds / 60)), pages, assumedPages };
}

export function formatEstimate(estimate: AuditEstimate): string {
  return estimate.assumedPages ? `~${estimate.minutes} min (≈${estimate.pages} pages assumed)` : `~${estimate.minutes} min`;
}
