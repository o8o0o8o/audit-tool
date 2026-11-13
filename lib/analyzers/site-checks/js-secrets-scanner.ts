/**
 * Scans the site's own JavaScript bundles for leaked credentials (cloud,
 * payment, chat, SCM, email and AI provider keys, PEM private keys). Matches
 * inside obvious placeholders are skipped and every secret is masked in the
 * report. A Firebase config found in a bundle is also checked for a publicly
 * readable Realtime Database (one shallow GET per database).
 */

import { SEVERITY } from '../../constants';
import type { Issue, SeverityLevel } from '../../types';
import { escapeHtml } from '../../utils';
import { defaultHttpFetcher, plural, runPool, type HttpProbeFetcher } from './http-probe';
import { orgDomain, type SiteProbeResult } from './site-checks-types';

export const MAX_SCRIPTS = 40;
const MAX_SCRIPT_BYTES = 3 * 1024 * 1024;
const MAX_FIREBASE_DBS = 5;
const CONCURRENCY = 3;

export interface SecretPattern {
  id: string;
  message: string;
  severity: SeverityLevel;
  re: RegExp;
  why: string;
  /** Optional per-match severity override (AWS: depends on a nearby secret key). */
  grade?: (match: string, source: string, index: number) => SeverityLevel;
}

const AWS_SECRET_NEAR = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;

/** True when a 40-char string within 200 chars looks like an AWS secret access key (mixed case + digit). */
export function hasNearbyAwsSecret(source: string, index: number, length: number): boolean {
  const win = source.slice(Math.max(0, index - 200), index + length + 200);
  for (const m of win.matchAll(AWS_SECRET_NEAR)) {
    const s = m[0];
    if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && !/^(?:[A-Za-z]+|[A-Z0-9]+)$/.test(s)) return true;
  }
  return false;
}

const CHECK_KEY_LIMITS =
  'Revoke the key, issue a new one and keep it on the server (environment variable or secrets manager).';

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: 'aws',
    message: 'AWS access key leaked in public JavaScript',
    severity: SEVERITY.MEDIUM,
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    why: 'An AWS access key ID is shipped to every visitor; with its secret key anyone can call AWS APIs as your account.',
    grade: (m, src, i) => (hasNearbyAwsSecret(src, i, m.length) ? SEVERITY.HIGH : SEVERITY.MEDIUM),
  },
  {
    id: 'stripe',
    message: 'Stripe live secret key leaked in public JavaScript',
    severity: SEVERITY.CRITICAL,
    re: /\b[rs]k_live_[0-9A-Za-z]{20,247}\b/g,
    why: 'A live Stripe secret/restricted key lets anyone issue charges, refunds and read customer data.',
  },
  {
    id: 'slack-token',
    message: 'Slack token leaked in public JavaScript',
    severity: SEVERITY.HIGH,
    re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/g,
    why: 'A Slack token gives API access to your workspace.',
  },
  {
    id: 'slack-webhook',
    message: 'Slack webhook URL leaked in public JavaScript',
    severity: SEVERITY.HIGH,
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g,
    why: 'Anyone with the webhook URL can post messages into your Slack channel.',
  },
  {
    id: 'github',
    message: 'GitHub token leaked in public JavaScript',
    severity: SEVERITY.HIGH,
    re: /\b(?:gh[po]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/g,
    why: 'A GitHub token gives access to repositories and organisation settings.',
  },
  {
    id: 'private-key',
    message: 'Private key leaked in public JavaScript',
    severity: SEVERITY.CRITICAL,
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    why: 'A private key in a public file breaks every signature or TLS/SSH session it protects.',
  },
  {
    id: 'sendgrid',
    message: 'SendGrid API key leaked in public JavaScript',
    severity: SEVERITY.HIGH,
    re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
    why: 'A SendGrid key lets anyone send email as your domain.',
  },
  {
    id: 'mailgun',
    message: 'Mailgun API key leaked in public JavaScript',
    severity: SEVERITY.HIGH,
    re: /\bkey-[0-9a-f]{32}\b/g,
    why: 'A Mailgun key lets anyone send email as your domain.',
  },
  {
    id: 'twilio-api-key',
    message: 'Twilio credential leaked in public JavaScript',
    severity: SEVERITY.HIGH,
    re: /\bSK[0-9a-f]{32}\b/g,
    why: 'Twilio credentials let anyone send SMS and place calls billed to your account.',
  },
  {
    id: 'twilio-auth-token',
    message: 'Twilio credential leaked in public JavaScript',
    severity: SEVERITY.HIGH,
    re: /(?:twilio\w*[^\n]{0,40}?auth_?token|TWILIO_AUTH_TOKEN)["'\s:=]+[0-9a-f]{32}\b/gi,
    why: 'Twilio credentials let anyone send SMS and place calls billed to your account.',
  },
  {
    id: 'openai',
    message: 'OpenAI API key leaked in public JavaScript',
    severity: SEVERITY.HIGH,
    re: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/g,
    why: 'An OpenAI key lets anyone run requests billed to your account.',
  },
  {
    id: 'anthropic',
    message: 'Anthropic API key leaked in public JavaScript',
    severity: SEVERITY.HIGH,
    re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}/g,
    why: 'An Anthropic key lets anyone run requests billed to your account.',
  },
  {
    id: 'google',
    message: 'Google API key in public JavaScript',
    severity: SEVERITY.LOW,
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    why: 'Google API keys are public by design for Maps/Firebase; verify API restrictions (HTTP referrer and API allow-list) in Google Cloud Console.',
  },
];

const PLACEHOLDER =
  /x{4,}|X{4,}|example|your[_-]?(?:api[_-]?|secret[_-]?)?(?:key|token)|placeholder|dummy|sample|0{8,}|1234567890|abcdefghij/i;

/** True when the match (or the 24 chars before it) is an obvious placeholder. */
export function isPlaceholder(match: string, source: string, index: number): boolean {
  return PLACEHOLDER.test(match) || PLACEHOLDER.test(source.slice(Math.max(0, index - 24), index));
}

/** First 4 + last 4 characters; PEM blocks are shown by their header only. */
export function maskSecret(secret: string): string {
  if (secret.startsWith('-----BEGIN')) return secret;
  if (secret.length <= 10) return `${secret.slice(0, 2)}…`;
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

export interface SecretMatch {
  patternId: string;
  message: string;
  severity: SeverityLevel;
  secret: string;
}

/** Pure scan of one script body. Deduped by secret value. */
export function findSecrets(source: string): SecretMatch[] {
  const out = new Map<string, SecretMatch>();
  for (const p of SECRET_PATTERNS) {
    for (const m of source.matchAll(p.re)) {
      const idx = m.index ?? 0;
      let secret = m[0];
      if (p.id === 'twilio-auth-token') secret = secret.slice(-32);
      if (isPlaceholder(secret, source, idx)) continue;
      if (out.has(secret)) continue;
      out.set(secret, {
        patternId: p.id,
        message: p.message,
        severity: p.grade ? p.grade(m[0], source, idx) : p.severity,
        secret,
      });
    }
  }
  return [...out.values()];
}

const FIREBASE_DB =
  /databaseURL["']?\s*:\s*["'](https:\/\/[a-z0-9-]+\.(?:firebaseio\.com|[a-z0-9-]+\.firebasedatabase\.app))\/?["']/gi;

/** Firebase Realtime Database URLs from `databaseURL: "..."` config objects. */
export function findFirebaseDatabases(source: string): string[] {
  return [...new Set([...source.matchAll(FIREBASE_DB)].map((m) => m[1].toLowerCase()))];
}

/** Same-site (same registrable domain) http(s) script URLs, deduped without fragments, capped. */
export function collectScriptUrls(origin: string, urls: Iterable<string>, limit = MAX_SCRIPTS): string[] {
  let org: string;
  try {
    org = orgDomain(new URL(origin).hostname);
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const raw of urls) {
    if (out.size >= limit) break;
    try {
      const u = new URL(raw, origin);
      if (!/^https?:$/.test(u.protocol)) continue;
      const h = u.hostname.toLowerCase();
      if (h !== org && !h.endsWith(`.${org}`)) continue;
      u.hash = '';
      out.add(u.href);
    } catch {
      /* skip */
    }
  }
  return [...out];
}

const SEVERITY_RANK: Record<SeverityLevel, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export class JsSecretsScanner {
  /**
   * `checkFirebase: false` (passive mode) keeps the key-pattern scan of the public scripts but does
   * not query a Firebase database named in them: that is a read of a data store, not of the site.
   */
  static async scan(
    scriptUrls: string[],
    fetcher: HttpProbeFetcher = defaultHttpFetcher,
    opts: { checkFirebase?: boolean } = {},
  ): Promise<SiteProbeResult> {
    const checkFirebase = opts.checkFirebase !== false;
    const scripts = [...new Set(scriptUrls)].slice(0, MAX_SCRIPTS);
    const hits = new Map<string, { severity: SeverityLevel; why: string; items: Map<string, string> }>();
    const firebase = new Set<string>();
    let fetched = 0;

    await runPool(scripts, CONCURRENCY, async (url) => {
      const res = await fetcher(url, { maxBytes: MAX_SCRIPT_BYTES, timeoutMs: 15000 });
      if (res?.status !== 200) return;
      fetched++;
      for (const db of findFirebaseDatabases(res.body)) firebase.add(db);
      for (const s of findSecrets(res.body)) {
        const p = SECRET_PATTERNS.find((x) => x.id === s.patternId)!;
        const hit = hits.get(s.message) ?? { severity: s.severity, why: p.why, items: new Map<string, string>() };
        if (SEVERITY_RANK[s.severity] > SEVERITY_RANK[hit.severity]) hit.severity = s.severity;
        if (!hit.items.has(s.secret)) hit.items.set(s.secret, url);
        hits.set(s.message, hit);
      }
    });

    const issues: Issue[] = [];
    for (const [message, hit] of hits) {
      const list = [...hit.items]
        .slice(0, 10)
        .map(([secret, url]) => `<code>${escapeHtml(maskSecret(secret))}</code> in ${escapeHtml(url)}`)
        .join('; ');
      const more = hit.items.size > 10 ? ` (+${hit.items.size - 10} more)` : '';
      const fix = hit.severity === SEVERITY.LOW ? '' : ` ${CHECK_KEY_LIMITS}`;
      issues.push({ message, detail: `${hit.why} Found: ${list}${more}.${fix}`, severity: hit.severity });
    }

    const openDbs: string[] = [];
    await runPool(checkFirebase ? [...firebase].slice(0, MAX_FIREBASE_DBS) : [], CONCURRENCY, async (db) => {
      const res = await fetcher(`${db}/.json?shallow=true`, { maxBytes: 64 * 1024, redirect: 'manual' });
      if (res?.status !== 200 || /Permission denied/i.test(res.body)) return;
      try {
        JSON.parse(res.body);
      } catch {
        return;
      }
      openDbs.push(db);
    });
    if (openDbs.length) {
      issues.push({
        message: 'Firebase Realtime Database is publicly readable',
        detail: `The Firebase config in the site's JavaScript points to a database that answers unauthenticated reads: ${openDbs.map((d) => escapeHtml(`${d}/.json`)).join(', ')}. Anyone can download its data. Lock down the Realtime Database security rules (".read": false or auth-based).`,
        severity: SEVERITY.HIGH,
      });
    }

    const failed = scripts.length > 0 && fetched === 0;
    return {
      issues,
      checks: [
        {
          id: 'js-secrets',
          label: 'Secrets in JavaScript',
          status: issues.some((i) => i.severity !== SEVERITY.LOW)
            ? 'fail'
            : issues.length
              ? 'warn'
              : failed || !scripts.length
                ? 'skipped'
                : 'pass',
          note: !scripts.length
            ? 'no same-site scripts found'
            : failed
              ? 'scripts could not be downloaded'
              : `${plural(fetched, 'script')} scanned${firebase.size ? `, ${plural(firebase.size, 'Firebase database')} ${checkFirebase ? 'checked' : 'found, not queried (passive mode)'}` : ''}${issues.length ? `, ${plural(issues.length, 'finding')}` : ''}`,
        },
      ],
    };
  }
}
