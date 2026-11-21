/**
 * Finding codes (design §8.2). A finding's code is derived from its title: HTML, counts, numbers,
 * quoted values and URLs are taken out into `params`, the rest becomes a kebab-case slug. Codes in
 * `check-types.json` are the explicit ones (seeded from the most frequent findings and every
 * security check); the rest are `derived`. A wording change that changes a code adds an alias.
 *
 * Only a stable check title gives a derived code. An error message, or a title that holds a URL, a
 * file path or mostly digits, would give a new code per site, so such a finding is `untyped` (its
 * title is kept). The decision depends on the title alone, so every build and load agrees.
 */
import { createHash } from 'node:crypto';
import checkTypesSeed from './check-types.json';

export interface CheckTypeSeed {
  code: string;
  title: string;
  family: string;
  category: string;
  default_severity: string;
}

export const CHECK_TYPES: readonly CheckTypeSeed[] = checkTypesSeed as CheckTypeSeed[];
const EXPLICIT = new Set(CHECK_TYPES.map((c) => c.code));

/** Old code → current code, for renamed or re-derived findings. */
export const CHECK_TYPE_ALIASES: Readonly<Record<string, string>> = {};

export const UNTYPED = 'untyped';

const URL_RE = /\bhttps?:\/\/[^\s"'<>)]+/gi;
const QUOTED_RE = /"([^"]*)"/g;
const NUMBER_RE = /(?<![A-Za-z])\d+(?:[.,]\d+)?%?(?![A-Za-z])/g;

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PATH_RE = /(?:^|[\s("'=:,])(?:~|\.{1,2}|[A-Za-z]:)?(?:[\\/][\w.@+-]+){2,}/;
const ERROR_RE =
  /^(?:audit failed|error during|uncaught|unhandled)\b|\b(?:fetch failed|is not a function|is not defined|cannot (?:read|find)|unexpected token)\b/i;
// case matters here: `TypeError:`, `ECONNRESET`, a stack frame
const ERROR_NAME_RE = /\b\w*(?:Error|Exception)\s*:|\bE[A-Z]{5,}\b|\bat \S+ \(/;
/** Longest title, in characters, that can name a check. */
export const MAX_STABLE_TITLE = 140;

/** True when a title names a check, not one site's data: no URL, no path, no error text, few digits. */
export function isStableTitle(title: string): boolean {
  const text = stripHtml(title);
  if (!text || text.length > MAX_STABLE_TITLE) return false;
  if (/\bhttps?:\/\//i.test(text) || /\bwww\.[a-z0-9-]+\.[a-z]{2,}/i.test(text)) return false;
  if (PATH_RE.test(text) || ERROR_RE.test(text) || ERROR_NAME_RE.test(text)) return false;
  if (/[\u0000-\u001f\u2500-\u259f]/.test(text)) return false;
  // a trailing "(24 pages)" is a count, not part of the name
  const body = text.replace(/\(\s*\d+(?:\s+[a-z][a-z-]{0,15})?\s*\)\s*$/i, '');
  const digits = body.replace(/[^0-9]/g, '').length;
  const tokens = body.match(NUMBER_RE)?.length ?? 0;
  return tokens <= 2 && digits <= Math.max(6, body.replace(/\s/g, '').length * 0.15);
}

export interface DerivedCode {
  code: string;
  params: Record<string, string | number | string[] | number[]>;
  explicit: boolean;
}

/** Title → code + params. Same title text, same code, on every build; `untyped` when the title is not stable. */
export function deriveCode(title: string): DerivedCode {
  let text = stripHtml(title);
  const params: DerivedCode['params'] = {};
  const urls = text.match(URL_RE);
  if (urls?.length) {
    params.urls = urls;
    text = text.replace(URL_RE, ' ');
  }
  const quoted = [...text.matchAll(QUOTED_RE)].map((m) => m[1]!);
  if (quoted.length) {
    params.values = quoted;
    text = text.replace(QUOTED_RE, ' ');
  }
  const trailing = text.match(/\(\s*(\d+)(?:\s+[a-z][a-z-]{0,15})?\s*\)\s*$/i);
  if (trailing) {
    params.count = Number(trailing[1]);
    text = text.slice(0, trailing.index);
  }
  const numbers = (text.match(NUMBER_RE) ?? []).map((n) => Number(n.replace('%', '').replace(',', '.')));
  if (numbers.length) {
    params.numbers = numbers;
    text = text.replace(NUMBER_RE, ' ');
  }
  text = text
    .replace(/%/g, ' ')
    .replace(/\(\s*[A-Z][A-Z0-9_-]*\s*\)/g, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+:\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  let code = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/(^|-)\d+(?=-|$)/g, '$1')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100)
    .replace(/-$/, '');
  if (!code) code = UNTYPED;
  code = CHECK_TYPE_ALIASES[code] ?? code;
  const explicit = EXPLICIT.has(code);
  if (!explicit && !isStableTitle(title)) code = UNTYPED;
  return { code, params, explicit };
}

/** A finding's id: UUID-shaped, derived from audit, code and params, so it survives reloads. */
export function findingId(auditId: string, code: string, params: unknown): string {
  const h = createHash('sha256')
    .update(`${auditId}\n${code}\n${JSON.stringify(params ?? {})}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
