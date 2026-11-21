/**
 * The prospect store the lead pipeline reads and writes (design §8.13). Two implementations:
 * - `CsvProspectStore`: docs/gtm/companies.csv, as before;
 * - `ApiProspectStore`: the platform's prospect routes (`prospects:read` + `prospects:write`), so no
 *   database credentials sit on our machines and no code path writes the CSV.
 * The API store is used when AUDIT_API_URL and AUDIT_API_KEY are set (or with --store=api).
 *
 * Reads are synchronous on a loaded copy so the pipeline's commands keep their shape; writes apply
 * to that copy at once and are sent in order; `flush()` waits for them.
 */
import {
  DO_NOT_CONTACT,
  KEY_COLUMN,
  domainOf,
  isDoNotContact,
  readCompanies,
  updateCompanies,
  type CompanyRecord,
  type RowUpdate,
} from './csv-store';

export interface GuardAnswer {
  allowed: boolean;
  reason?: string;
}

export interface ProspectStore {
  readonly kind: 'csv' | 'api';
  load(): Promise<void>;
  records(): CompanyRecord[];
  /** Sets columns on rows by website; returns the websites not found. Never changes a do_not_contact stage. */
  update(updates: RowUpdate[]): string[];
  flush(): Promise<void>;
  /** May this domain be scanned (the platform's scan guard; the CSV store checks do_not_contact rows)? */
  guard(domain: string): Promise<GuardAnswer>;
}

export class CsvProspectStore implements ProspectStore {
  readonly kind = 'csv' as const;
  constructor(readonly csvPath: string) {}
  async load() {}
  records() {
    return readCompanies(this.csvPath);
  }
  update(updates: RowUpdate[]) {
    return updateCompanies(this.csvPath, updates);
  }
  async flush() {}
  async guard(domain: string): Promise<GuardAnswer> {
    const row = this.records().find((r) => r[KEY_COLUMN]?.trim() && domainOf(r[KEY_COLUMN]) === domainOf(domain));
    return row && isDoNotContact(row) ? { allowed: false, reason: 'do_not_contact' } : { allowed: true };
  }
}

interface ApiProspect {
  id: string;
  website: string | null;
  record: CompanyRecord;
}

export class ApiProspectStore implements ProspectStore {
  readonly kind = 'api' as const;
  private rows: Array<{ id: string; record: CompanyRecord }> = [];
  private chain: Promise<void> = Promise.resolve();
  private errors: string[] = [];

  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async load() {
    const { prospects } = await this.call<{ prospects: ApiProspect[] }>('GET', '/api/v1/prospects');
    this.rows = prospects.map((p) => ({ id: p.id, record: { ...p.record } }));
  }

  records() {
    return this.rows.map((r) => ({ ...r.record }));
  }

  update(updates: RowUpdate[]) {
    const missing: string[] = [];
    for (const u of updates) {
      const targets = this.rows.filter((r) => r.record[KEY_COLUMN] === u.website);
      if (!targets.length) {
        missing.push(u.website);
        continue;
      }
      for (const t of targets) {
        if (t.record.stage?.trim() === DO_NOT_CONTACT) continue; // never changed, like the CSV store
        Object.assign(t.record, u.values);
        const values = { ...u.values };
        this.chain = this.chain.then(() =>
          this.call('PATCH', `/api/v1/prospects/${t.id}`, { values }).then(
            () => undefined,
            (err: Error) => void this.errors.push(`${u.website}: ${err.message}`),
          ),
        );
      }
    }
    return missing;
  }

  async flush() {
    await this.chain;
    if (this.errors.length) {
      const e = this.errors.splice(0);
      throw new Error(`prospect updates failed:\n${e.join('\n')}`);
    }
  }

  async guard(domain: string): Promise<GuardAnswer> {
    return this.call<GuardAnswer>('GET', `/api/v1/guard?domain=${encodeURIComponent(domain)}`);
  }
}

export function apiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.AUDIT_API_URL && env.AUDIT_API_KEY);
}

/** API store when configured (or `store=api`), else the CSV. */
export function openProspectStore(opts: {
  csvPath: string;
  store?: string | null;
  env?: NodeJS.ProcessEnv;
}): ProspectStore {
  const env = opts.env ?? process.env;
  const want = opts.store ?? (apiConfigured(env) ? 'api' : 'csv');
  if (want === 'api') {
    if (!apiConfigured(env)) throw new Error('--store=api needs AUDIT_API_URL and AUDIT_API_KEY');
    return new ApiProspectStore(env.AUDIT_API_URL!, env.AUDIT_API_KEY!);
  }
  return new CsvProspectStore(opts.csvPath);
}
