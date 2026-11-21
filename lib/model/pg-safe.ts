/**
 * Postgres rejects a NUL character in text and jsonb, and a lone UTF-16 surrogate in jsonb. Crawled
 * text can hold both (a truncated emoji leaves half a pair). `pgSafe` removes NULs and replaces lone
 * surrogates with U+FFFD, in place, in every string and object key of a JSON value.
 */
const UNSAFE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const NUL = /\u0000/g;
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export function pgSafeText(s: string): string {
  return UNSAFE.test(s) ? s.replace(NUL, '').replace(LONE, '�') : s;
}

export function pgSafe<T>(value: T): T {
  if (typeof value === 'string') return pgSafeText(value) as T;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const v: unknown = value[i];
      if (typeof v === 'string' || (v && typeof v === 'object')) value[i] = pgSafe(v);
    }
    return value;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const v = o[k];
      const safe = typeof v === 'string' || (v && typeof v === 'object') ? pgSafe(v) : v;
      const key = pgSafeText(k);
      if (key !== k) delete o[k];
      o[key] = safe;
    }
  }
  return value;
}
