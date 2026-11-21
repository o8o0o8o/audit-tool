/**
 * The prospect store the lead pipeline reads and writes (design §8.13). Two implementations:
 * - `CsvProspectStore`: docs/gtm/companies.csv, as before;
 * - `ApiProspectStore`: the platform's prospect routes (`prospects:read` + `prospects:write`), so no
 *   database credentials sit on our machines and no code path writes the CSV.
 * The API store is used when AUDIT_API_URL and AUDIT_API_KEY are set (or with --store=api).
 *
 * Reads are synchronous on a loaded copy so the pipeline's commands keep their shape; writes apply
 * to that copy at once and are sent in order; `flush()` waits for them. Updates the platform did not
 * take are kept in a file next to the lead results and sent first on the next load.
 *
 * With the platform configured, the CSV store still asks the platform's scan guard, so the two lists
 * cannot disagree about who must not be scanned.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LEAD_RESULTS_DIR } from './paths';
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

const GUARD_TIMEOUT_MS = 15_000;

/**
 * Asks the platform's scan guard (`GET /api/v1/guard?domain=`). Fails closed: when the platform does
 * not answer, or answers with anything but a guard result, the domain is refused.
 */
export async function askPlatformGuard(
  baseUrl: string,
  apiKey: string,
  domain: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GuardAnswer> {
  const refused = (why: string): GuardAnswer => ({
    allowed: false,
    reason: `the audit platform at ${baseUrl} ${why}, so its do-not-contact list could not be checked`,
  });
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/v1/guard?domain=${encodeURIComponent(domain)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(GUARD_TIMEOUT_MS),
    });
    if (!res.ok) return refused(`answered ${res.status}`);
    const answer = (await res.json()) as GuardAnswer;
    if (typeof answer?.allowed !== 'boolean') return refused('gave an unreadable answer');
    return answer.allowed ? { allowed: true } : { allowed: false, reason: answer.reason ?? 'blocked' };
  } catch (error) {
    return refused(`could not be reached (${(error as Error).message})`);
  }
}

export class CsvProspectStore implements ProspectStore {
  readonly kind = 'csv' as const;
  constructor(
    readonly csvPath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async load() {}
  records() {
    return readCompanies(this.csvPath);
  }
  update(updates: RowUpdate[]) {
    return updateCompanies(this.csvPath, updates);
  }
  async flush() {}
  /**
   * The CSV's do_not_contact rows and, when the platform is configured, its guard too: a domain
   * marked do_not_contact or suppressed there is refused even though the CSV does not say so.
   */
  async guard(domain: string): Promise<GuardAnswer> {
    const row = this.records().find((r) => r[KEY_COLUMN]?.trim() && domainOf(r[KEY_COLUMN]) === domainOf(domain));
    if (row && isDoNotContact(row)) return { allowed: false, reason: 'do_not_contact' };
    if (!apiConfigured(this.env)) return { allowed: true };
    return askPlatformGuard(this.env.AUDIT_API_URL!, this.env.AUDIT_API_KEY!, domain, this.fetchImpl);
  }
}

interface ApiProspect {
  id: string;
  website: string | null;
  record: CompanyRecord;
}

/** An update the platform has not taken yet. */
interface PendingUpdate {
  website: string;
  values: Record<string, string>;
}

class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 when the platform did not answer. */
    readonly status: number,
  ) {
    super(message);
  }
  /** The platform read the request and said no: sending it again changes nothing. */
  get rejected(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

export interface ApiStoreOptions {
  /** Updates the platform did not take are kept here and sent again on the next load. */
  pendingFile?: string;
  retries?: number;
  retryDelayMs?: number;
}

/** Next to the lead results, never under `audit-results/`. */
export const DEFAULT_PENDING_FILE = path.join(LEAD_RESULTS_DIR, 'pending-prospect-updates.json');

export class ApiProspectStore implements ProspectStore {
  readonly kind = 'api' as const;
  private rows: Array<{ id: string; record: CompanyRecord }> = [];
  private chain: Promise<void> = Promise.resolve();
  private errors: string[] = [];
  private unsent: PendingUpdate[] = [];
  private readonly pendingFile: string;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    opts: ApiStoreOptions = {},
  ) {
    this.pendingFile = opts.pendingFile ?? DEFAULT_PENDING_FILE;
    this.retries = opts.retries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 2000;
  }

  async call<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${apiPath}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ApiError(
        `The audit platform at ${this.baseUrl} (AUDIT_API_URL) could not be reached: ${(error as Error).message}. ` +
          'Start it, or pass --store=csv to work from the CSV (site scans stay refused until the platform answers).',
        0,
      );
    }
    const text = await res.text();
    if (!res.ok) throw new ApiError(`${method} ${apiPath} → ${res.status} ${text.slice(0, 300)}`, res.status);
    return JSON.parse(text) as T;
  }

  async load() {
    const { prospects } = await this.call<{ prospects: ApiProspect[] }>('GET', '/api/v1/prospects');
    this.rows = prospects.map((p) => ({ id: p.id, record: { ...p.record } }));
    await this.replayPending();
  }

  /** Sends the updates an earlier run could not deliver, before anything reads the rows. */
  private async replayPending(): Promise<void> {
    const pending = this.readPending();
    if (!pending.length) return;
    for (let i = 0; i < pending.length; i++) {
      const u = pending[i]!;
      for (const t of this.rows.filter((r) => r.record[KEY_COLUMN] === u.website)) {
        if (t.record.stage?.trim() === DO_NOT_CONTACT) continue;
        try {
          await this.call('PATCH', `/api/v1/prospects/${t.id}`, { values: u.values });
          Object.assign(t.record, u.values);
        } catch (error) {
          if (error instanceof ApiError && error.rejected) {
            console.warn(`Saved update for ${u.website} was refused by the platform and is dropped: ${error.message}`);
            continue;
          }
          this.writePending(pending.slice(i));
          throw new Error(
            `Updates saved by an earlier run (${this.pendingFile}) could not be sent: ${(error as Error).message}`,
            { cause: error },
          );
        }
      }
    }
    this.writePending([]);
    console.log(`Sent ${pending.length} prospect update(s) saved by an earlier run.`);
  }

  private readPending(): PendingUpdate[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.pendingFile, 'utf8')) as PendingUpdate[];
      return Array.isArray(parsed) ? parsed.filter((u) => u && typeof u.website === 'string' && u.values) : [];
    } catch {
      return [];
    }
  }

  private writePending(pending: PendingUpdate[]): void {
    if (!pending.length) {
      fs.rmSync(this.pendingFile, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.pendingFile), { recursive: true });
    fs.writeFileSync(this.pendingFile, JSON.stringify(pending, null, 2));
  }

  records() {
    return this.rows.map((r) => ({ ...r.record }));
  }

  private async send(id: string, u: PendingUpdate): Promise<'sent' | 'unsent'> {
    try {
      await this.call('PATCH', `/api/v1/prospects/${id}`, { values: u.values });
      return 'sent';
    } catch (error) {
      if (error instanceof ApiError && !error.rejected) return 'unsent';
      this.errors.push(`${u.website}: ${(error as Error).message}`);
      return 'sent';
    }
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
        const pending: PendingUpdate = { website: u.website, values: { ...u.values } };
        this.chain = this.chain.then(async () => {
          // Order matters (a later update may overwrite an earlier one): once one waits, all later ones wait.
          if (this.unsent.length || (await this.send(t.id, pending)) === 'unsent') this.unsent.push(pending);
        });
      }
    }
    return missing;
  }

  /**
   * Waits for the updates. Those the platform did not take (down, 5xx) are tried again a few times,
   * then written to the pending file, so a stage reached by a finished scan is not lost.
   */
  async flush() {
    await this.chain;
    for (let attempt = 0; attempt < this.retries && this.unsent.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      const queue = this.unsent.splice(0);
      for (let i = 0; i < queue.length; i++) {
        const u = queue[i]!;
        const ids = this.rows.filter((r) => r.record[KEY_COLUMN] === u.website).map((r) => r.id);
        let failed = false;
        for (const id of ids) if ((await this.send(id, u)) === 'unsent') failed = true;
        if (failed) {
          this.unsent = queue.slice(i);
          break;
        }
      }
    }
    const problems: string[] = [];
    if (this.unsent.length) {
      const saved = this.unsent.splice(0);
      this.writePending([...this.readPending(), ...saved]);
      problems.push(
        `${saved.length} prospect update(s) could not be sent to ${this.baseUrl}. They are saved in ${this.pendingFile} and are sent first on the next run.`,
      );
    }
    if (this.errors.length) problems.push(`prospect updates failed:\n${this.errors.splice(0).join('\n')}`);
    if (problems.length) throw new Error(problems.join('\n'));
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
  return new CsvProspectStore(opts.csvPath, env);
}
