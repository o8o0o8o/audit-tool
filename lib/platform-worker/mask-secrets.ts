/**
 * No unmasked secrets in stored files (design §8.14). Before a file is stored (final upload and
 * checkpoint snapshots), its text is masked: the JS-secrets scanner's vendor key patterns, private
 * key blocks, JWTs, `Authorization` / `Cookie` / `Set-Cookie` header values, passwords in URLs and
 * secret-looking query / body parameters. Gzip files are opened, masked and packed again.
 *
 * Text is handled as latin1 (one char per byte), so any encoding survives the round trip and a
 * file of any size is masked window by window. A span is only ever a run of characters without
 * `"` or `\`, so JSON stays valid. The recorded sha256 stays that of the original answer;
 * `platform/masked.json` notes what was masked and which files could not be (those are not stored).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { findSecrets } from '../analyzers/site-checks/js-secrets-scanner';
import { walkFiles } from './snapshot';

const BINARY = /\.(png|jpe?g|webp|gif|avif|ico|bmp|pdf|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|zip|tar\.gz|tgz|tar)$/i;
/** Window and overlap of the chunked pass; a secret with its context must fit in the overlap. */
const WINDOW = 4 * 1024 * 1024;
const OVERLAP = 64 * 1024;
/** Above this a masked JSON file is not parsed again to prove it is still JSON. */
const JSON_CHECK_MAX = 64 * 1024 * 1024;
const MASK_FILE = 'platform/masked.json';

export interface MaskRecord {
  sha256Original: string;
  masked: number;
  patterns: string[];
  /** Set when the file could not be masked; it must not be stored. */
  notMasked?: string;
}

interface Span {
  /** Start of the match with its context (header name, parameter name); where a window may be cut. */
  cs: number;
  s: number;
  e: number;
  id: string;
  full?: boolean;
}

const HEADER_NAMES = 'proxy-authorization|authorization|set-cookie|cookie|x-api-key|x-auth-token|x-amz-security-token';
const HEADER_LINE = new RegExp(`(?<![\\w-])(${HEADER_NAMES})\\\\?["']?\\s*:\\s*\\\\?["']?([^"'\\r\\n\\\\]*)`, 'gi');
const HEADER_PAIR = new RegExp(`"name"\\s*:\\s*"(${HEADER_NAMES})"\\s*,\\s*"value"\\s*:\\s*"([^"\\\\]*)`, 'gi');
const COOKIE_ATTRS = /^(path|domain|expires|max-age|samesite|secure|httponly|priority|partitioned|version)$/i;
const TOKEN_CHARS = /^[A-Za-z0-9._~%+/=-]+$/;

const STRONG = 'token|secret|password|passwd|pwd|sig|signature|api[_-]?key';
const PARAM_NAME = `(?:[A-Za-z0-9_.-]*[_.-])?(?:${STRONG}|key)`;
const PARAM_URL = new RegExp(`([?&]|&amp;|\\\\u0026|^|[\\s"'>])(${PARAM_NAME})=([^&#\\s"'\\\\<>;]+)`, 'gim');
const PARAM_JSON = new RegExp(`(\\\\?["'])(${PARAM_NAME})\\1\\s*:\\s*\\\\?["']([^"'\\\\]+)`, 'gi');
const IS_STRONG = new RegExp(`(?:^|[_.-])(?:${STRONG})$`, 'i');
const IS_PASSWORD = /(?:^|[_.-])(?:password|passwd|pwd|client[_-]?secret)$/i;

const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----([A-Za-z0-9+/=\s\\:,-]{1,16384}?)-----END/g;
const BEARER = /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{16,})/g;
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@"'\\<>]{1,128}:([^\s/@"'\\<>]{1,256})@/gi;

/** At least 16 characters of mixed letters and digits: a value that is a secret, not a word or an id. */
function secretLike(v: string): boolean {
  return v.length >= 16 && TOKEN_CHARS.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v);
}

function headerSpans(name: string, value: string, at: number, cs: number, out: Span[]): void {
  const n = name.toLowerCase();
  if (n === 'cookie' || n === 'set-cookie') {
    for (const p of value.matchAll(/([^=;\s]+)=([^;]*)/g)) {
      const v = p[2]!.trimEnd();
      if (!v || COOKIE_ATTRS.test(p[1]!)) continue;
      const s = at + p.index + p[1]!.length + 1;
      out.push({ cs, s, e: s + v.length, id: n });
    }
    return;
  }
  if (n === 'authorization' || n === 'proxy-authorization') {
    const m = /^((?:Bearer|Basic|Token|Digest|Negotiate|ApiKey)\s+)?(.*)$/i.exec(value)!;
    const rest = m[2]!.trimEnd();
    if (!rest || (!m[1] && !(rest.length >= 8 && TOKEN_CHARS.test(rest)))) return;
    const s = at + (m[1]?.length ?? 0);
    out.push({ cs, s, e: s + rest.length, id: 'authorization' });
    return;
  }
  const v = value.trimEnd();
  if (v.length >= 8 && TOKEN_CHARS.test(v)) out.push({ cs, s: at, e: at + v.length, id: n });
}

function collectSpans(text: string): Span[] {
  const out: Span[] = [];
  for (const f of findSecrets(text)) {
    if (f.secret.startsWith('-----BEGIN')) continue;
    for (let i = text.indexOf(f.secret); i !== -1; i = text.indexOf(f.secret, i + f.secret.length)) {
      out.push({ cs: i, s: i, e: i + f.secret.length, id: f.patternId });
    }
  }
  for (const m of text.matchAll(PRIVATE_KEY)) {
    const s = m.index + m[0].length - 8 - m[1]!.length;
    out.push({ cs: m.index, s, e: s + m[1]!.length, id: 'private-key', full: true });
  }
  for (const m of text.matchAll(JWT)) out.push({ cs: m.index, s: m.index, e: m.index + m[0].length, id: 'jwt' });
  for (const re of [HEADER_LINE, HEADER_PAIR]) {
    for (const m of text.matchAll(re)) {
      headerSpans(m[1]!, m[2]!, m.index + m[0].length - m[2]!.length, m.index, out);
    }
  }
  for (const m of text.matchAll(BEARER)) {
    const v = m[1]!;
    const kinds = [/[a-z]/, /[A-Z]/, /\d/].filter((re) => re.test(v)).length;
    if (kinds >= 2)
      out.push({ cs: m.index, s: m.index + m[0].length - v.length, e: m.index + m[0].length, id: 'authorization' });
  }
  for (const m of text.matchAll(URL_PASSWORD)) {
    const e = m.index + m[0].length - 1;
    out.push({ cs: m.index, s: e - m[1]!.length, e, id: 'url-password' });
  }
  for (const m of text.matchAll(PARAM_URL)) {
    const [, prefix, name, value] = m as unknown as [string, string, string, string];
    const inQuery = prefix === '?' || prefix.includes('&') || prefix === '\\u0026';
    const strong = IS_STRONG.test(name);
    const ok = !strong
      ? secretLike(value)
      : inQuery || (TOKEN_CHARS.test(value) && (IS_PASSWORD.test(name) || value.length >= 8));
    if (ok)
      out.push({ cs: m.index, s: m.index + m[0].length - value.length, e: m.index + m[0].length, id: 'parameter' });
  }
  for (const m of text.matchAll(PARAM_JSON)) {
    const name = m[2]!;
    const value = m[3]!;
    if (IS_PASSWORD.test(name) || secretLike(value)) {
      out.push({ cs: m.index, s: m.index + m[0].length - value.length, e: m.index + m[0].length, id: 'parameter' });
    }
  }
  // Overlapping spans become one, so nothing between two matches is left readable.
  out.sort((a, b) => a.s - b.s || b.e - a.e);
  const merged: Span[] = [];
  for (const sp of out) {
    const last = merged[merged.length - 1];
    if (last && sp.s < last.e) {
      last.e = Math.max(last.e, sp.e);
      last.cs = Math.min(last.cs, sp.cs);
      if (sp.full) last.full = true;
    } else if (sp.e > sp.s) merged.push({ ...sp });
  }
  return merged;
}

/** First four and last four characters; short or non-ASCII values are replaced whole. Null: already masked. */
function maskValue(v: string, ell: string, full?: boolean): string | null {
  if (v.includes(ell)) return null;
  if (full || v.length < 16 || /[^\x20-\x7e]/.test(v)) return ell;
  return `${v.slice(0, 4)}${ell}${v.slice(-4)}`;
}

interface Tally {
  masked: number;
  patterns: Set<string>;
}

function apply(text: string, spans: Span[], end: number, ell: string, tally: Tally): string {
  let out = '';
  let pos = 0;
  for (const sp of spans) {
    if (sp.e > end) break;
    const r = maskValue(text.slice(sp.s, sp.e), ell, sp.full);
    if (r === null) continue;
    out += text.slice(pos, sp.s) + r;
    pos = sp.e;
    tally.masked++;
    tally.patterns.add(sp.id);
  }
  return out + text.slice(pos, end);
}

export function maskText(text: string): { text: string; masked: number; patterns: string[] } {
  const tally: Tally = { masked: 0, patterns: new Set() };
  const out = apply(text, collectSpans(text), text.length, '…', tally);
  return { text: out, masked: tally.masked, patterns: [...tally.patterns] };
}

/** "…" as its UTF-8 bytes, for text held as latin1. */
const ELL_BYTES = '\xE2\x80\xA6';

/**
 * Masks a file's bytes window by window. The tail of each window is carried into the next one, and
 * a window is never cut inside a match, so a secret on a window border is masked like any other.
 */
export function maskBytes(
  body: Uint8Array,
  windowBytes = WINDOW,
  overlap = OVERLAP,
): { body: Buffer; masked: number; patterns: string[] } {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const tally: Tally = { masked: 0, patterns: new Set() };
  const parts: Buffer[] = [];
  let carry = '';
  for (let off = 0; off < buf.length || carry; ) {
    const next = Math.min(buf.length, off + windowBytes);
    const text = carry + buf.toString('latin1', off, next);
    off = next;
    const last = off >= buf.length;
    const spans = collectSpans(text);
    let cut = last ? text.length : Math.max(0, text.length - overlap);
    if (!last) {
      for (let i = spans.length - 1; i >= 0; i--) if (spans[i]!.e >= cut && spans[i]!.cs < cut) cut = spans[i]!.cs;
    }
    parts.push(Buffer.from(apply(text, spans, cut, ELL_BYTES, tally), 'latin1'));
    carry = text.slice(cut);
    if (last) break;
  }
  return tally.masked
    ? { body: Buffer.concat(parts), masked: tally.masked, patterns: [...tally.patterns] }
    : { body: buf, masked: 0, patterns: [] };
}

const isJson = (v: Buffer): boolean => {
  try {
    JSON.parse(v.toString('utf8'));
    return true;
  } catch {
    return false;
  }
};

/**
 * Masks one file's content by its name: binary files and tar archives are left alone, gzip files
 * are opened and packed again. Returns the same buffer when nothing was masked. Throws when the file
 * cannot be masked (a gzip file that does not open, JSON that would no longer parse): the caller
 * must then not store it.
 */
export function maskFileBytes(name: string, body: Buffer): { body: Buffer; masked: number; patterns: string[] } {
  const none = { body, masked: 0, patterns: [] };
  if (BINARY.test(name)) return none;
  const gz = /\.gz$/i.test(name);
  const plain = gz ? gunzipSync(body) : body;
  if (plain.subarray(0, 8000).includes(0)) return none;
  const res = maskBytes(plain);
  if (!res.masked) return none;
  if (/\.json(\.gz)?$/i.test(name) && plain.length <= JSON_CHECK_MAX && isJson(plain) && !isJson(res.body)) {
    throw new Error('masking would break the JSON');
  }
  return { ...res, body: gz ? gzipSync(res.body) : res.body };
}

/**
 * Masks secrets in the files of a run, in place. By default every file of the run folder; `dirs`
 * limits it to those folders (`.` is the run folder's own files). A file that cannot be masked is
 * recorded with `notMasked` and, when `quarantineDir` is given, moved there.
 */
export function maskSecretsInRun(
  runDir: string,
  dirs?: string[],
  opts: { quarantineDir?: string } = {},
): Record<string, MaskRecord> {
  const record = readMaskRecord(runDir);
  const files = new Set<string>();
  if (!dirs) for (const f of walkFiles(runDir)) files.add(f);
  else {
    for (const d of dirs) {
      const abs = path.join(runDir, d);
      for (const f of d === '.' ? walkFiles(abs).filter((x) => path.dirname(x) === runDir) : walkFiles(abs))
        files.add(f);
    }
  }
  for (const f of files) {
    const rel = path.relative(runDir, f).split(path.sep).join('/');
    if (rel === MASK_FILE) continue;
    let original: Buffer | null = null;
    try {
      original = readFileSync(f);
      const { body, masked, patterns } = maskFileBytes(rel, original);
      if (record[rel]?.notMasked) delete record[rel];
      if (!masked) continue;
      // A second pass over a file masked before keeps the hash of the first original.
      record[rel] = {
        sha256Original: record[rel]?.sha256Original ?? createHash('sha256').update(original).digest('hex'),
        masked: masked + (record[rel]?.masked ?? 0),
        patterns: [...new Set([...(record[rel]?.patterns ?? []), ...patterns])],
      };
      writeFileSync(f, body);
    } catch (err) {
      record[rel] = {
        sha256Original: original ? createHash('sha256').update(original).digest('hex') : '',
        masked: 0,
        patterns: [],
        notMasked: String(err instanceof Error ? err.message : err).slice(0, 200),
      };
      if (opts.quarantineDir) {
        const dest = path.join(opts.quarantineDir, rel);
        try {
          mkdirSync(path.dirname(dest), { recursive: true });
          renameSync(f, dest);
        } catch {
          /* still listed as notMasked, so it is not uploaded */
        }
      }
    }
  }
  if (Object.keys(record).length) {
    mkdirSync(path.join(runDir, 'platform'), { recursive: true });
    writeFileSync(path.join(runDir, MASK_FILE), JSON.stringify(record, null, 2));
  }
  return record;
}

export function readMaskRecord(runDir: string): Record<string, MaskRecord> {
  try {
    return JSON.parse(readFileSync(path.join(runDir, MASK_FILE), 'utf8')) as Record<string, MaskRecord>;
  } catch {
    return {};
  }
}
