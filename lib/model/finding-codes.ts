/**
 * Finding codes (design §8.2). A finding's code is derived from its title: HTML, counts, numbers,
 * quoted values and URLs are taken out into `params`, the rest becomes a kebab-case slug. Codes in
 * `check-types.json` are the explicit ones (seeded from the most frequent findings and every
 * security check); the rest are `derived`. A wording change that changes a code adds an alias.
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

export interface DerivedCode {
  code: string;
  params: Record<string, string | number | string[] | number[]>;
  explicit: boolean;
}

/** Title → code + params. Same title text, same code, on every build. */
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
  return { code, params, explicit: EXPLICIT.has(code) };
}

/** A finding's id: UUID-shaped, derived from audit, code and params, so it survives reloads. */
export function findingId(auditId: string, code: string, params: unknown): string {
  const h = createHash('sha256')
    .update(`${auditId}\n${code}\n${JSON.stringify(params ?? {})}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
