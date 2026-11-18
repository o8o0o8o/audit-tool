import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PageSnapshot } from '../lib/leads/fingerprint';
import type { RunData, RunPage } from '../lib/leads/run-data';
import {
  buildLeadFile,
  compareGateRuns,
  gateRunStamp,
  leadDir,
  listGateRuns,
  readLeadFile,
  writeLeadFile,
  type LeadFile,
} from '../lib/leads/lead-file';
import {
  runGate,
  traceIo,
  type GateBrowser,
  type GateIo,
  type Highlight,
  type Observation,
} from '../lib/leads/truth-gate';

const ORIGIN = 'https://example.com';
const u = (p: string) => `${ORIGIN}${p}`;
const SHELL = '<!doctype html><html><head><title>T</title></head><body><div id="root"></div></body></html>';
const snap = (status: number, body: string, url: string, headers: Record<string, string> = {}): PageSnapshot => ({
  status,
  url,
  headers: { 'content-type': 'text/html', server: 'test', 'set-cookie': 'secret=1', ...headers },
  body,
});

function io(routes: Record<string, PageSnapshot | null> = {}, browser: GateBrowser | null = null): GateIo {
  return {
    randomPath: () => '/lead-check-test',
    browser,
    get: async (url) => {
      if (url in routes) return routes[url]!;
      if (url === u('/')) return snap(200, SHELL, url);
      return snap(404, 'Not found', url);
    },
  };
}

function run(runDir: string, pages: RunPage[]): RunData {
  return {
    runDir,
    kind: 'lead',
    metadata: {
      leadScan: {
        cap: 25,
        home: u('/'),
        selected: pages.map((p) => ({
          url: p.url,
          reason: p.url === u('/') ? 'homepage' : 'navigation',
          template: '/',
        })),
        disallowedByRobots: [],
        languages: [],
        sitemapTotal: 5,
        sitemapSample: [],
      },
    },
    pages: Object.fromEntries(pages.map((p) => [p.url, p])),
    findings: {},
  };
}

const home = (): RunPage => ({ url: u('/'), status: 200, foundIn: 'sitemap', contentQuality: { wordCount: 500 } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lead-evidence-'));
const highlight = (rootCause: string, fact: string, type = 'noindex'): Highlight => ({
  type: type as Highlight['type'],
  rootCause,
  angle: 'x',
  fact,
  url: u('/'),
  evidence: {
    methods: ['a', 'b'],
    control: { homepage: 200, randomMissing: 404 },
    checkedAt: '2026-11-18T10:00:00.000Z',
  },
  gate: 'pass',
});

void describe('observations behind a fact', () => {
  void it('records every request with the headers the checks read, and nothing else from the headers', async () => {
    const trace: Observation[] = [];
    const traced = traceIo(
      io({ [u('/a')]: snap(200, '<p>hi</p>', u('/b'), { 'x-robots-tag': 'noindex' }), [u('/gone')]: null }),
      trace,
    );
    await traced.get(u('/a'));
    await traced.get(u('/gone'));
    assert.equal(trace.length, 2);
    assert.deepEqual(
      { ...trace[0], at: 'x' },
      {
        method: 'http-get',
        at: 'x',
        url: u('/a'),
        finalUrl: u('/b'),
        status: 200,
        headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex', server: 'test' },
        body: '<p>hi</p>',
      },
    );
    assert.deepEqual({ ...trace[1], at: 'x' }, { method: 'http-get', at: 'x', url: u('/gone'), status: null });
  });

  void it('records browser calls and DNS lookups with their results, and leaves the tools working', async () => {
    const trace: Observation[] = [];
    class Browser {
      #secret = 7;
      async openPage(url: string) {
        return { status: url.endsWith('/x') ? 404 : 200, n: this.#secret };
      }
      async readRuntime() {
        return null;
      }
      async followLink() {
        return null;
      }
      async close() {
        return 'closed';
      }
    }
    const dns = [
      {
        name: 'cloudflare',
        resolveTxt: async () => [['v=spf1 -all']],
        resolveMx: async () => [],
        resolveCaa: async () => [],
      },
    ];
    const traced = traceIo({ ...io({}, new Browser() as unknown as GateBrowser), dns }, trace);
    assert.deepEqual(await traced.browser!.openPage(u('/x')), { status: 404, n: 7 });
    assert.deepEqual(await traced.dns![0]!.resolveTxt('example.com'), [['v=spf1 -all']]);
    assert.equal(await (traced.browser as unknown as Browser).close(), 'closed');
    assert.deepEqual(
      trace.map((o) => [o.method, o.url, o.status]),
      [
        ['browser:openPage', u('/x'), 404],
        ['dns:cloudflare:resolveTxt', 'example.com', undefined],
      ],
    );
    assert.match(trace[1]!.body ?? '', /v=spf1 -all/);
  });

  void it('a passed fact carries what was asked while it was checked; the control has its own', async () => {
    const gate = await runGate(run('/nonexistent', [home()]), null, io());
    const h = gate.highlights.find((x) => x.type === 'content-not-served');
    assert.ok(h);
    assert.deepEqual(
      h.evidence.observations?.map((o) => [o.method, o.url, o.status]),
      [['http-get', u('/'), 200]],
    );
    assert.equal(h.evidence.observations?.[0]?.body, SHELL);
    assert.deepEqual(
      gate.controlObservations?.map((o) => [o.url, o.status]),
      [
        [u('/'), 200],
        [u('/lead-check-test'), 404],
      ],
    );
  });
});

void describe('gate runs are kept', () => {
  void it('saves each raw answer to a file with its size and hash, and keeps lead.json small', async () => {
    const dir = tmp();
    const data = run(dir, [home()]);
    const gate = await runGate(data, null, io());
    const lead = buildLeadFile({
      domain: 'example.com',
      company: 'Example',
      run: data,
      stack: null,
      gate,
      fitScore: 40,
      scannedAt: null,
      runStamp: 'run-1',
    });
    const o = lead.highlights[0]!.evidence.observations![0]!;
    assert.equal(o.body, undefined);
    assert.equal(o.file, path.join('evidence', 'run-1', '1-content-not-served', '01-http-get.html'));
    assert.equal(fs.readFileSync(path.join(leadDir(dir), o.file!), 'utf8'), SHELL);
    assert.equal(o.bytes, Buffer.byteLength(SHELL));
    assert.equal(o.sha256, crypto.createHash('sha256').update(SHELL).digest('hex'));
    assert.equal(lead.controlObservations?.length, 2);
    assert.ok(fs.existsSync(path.join(leadDir(dir), 'evidence', 'run-1', 'control', '02-http-get.html')));
    assert.ok(!JSON.stringify(lead).includes('id=\\"root\\"'), 'no response body inside lead.json');
  });

  void it('never overwrites a run: lead.json is the latest, gate-runs holds all, and the change is recorded', async () => {
    const dir = tmp();
    const base = (
      checkedAt: string,
      highlights: Highlight[],
      dropped: LeadFile['candidatesDropped'] = [],
    ): LeadFile => ({
      domain: 'example.com',
      company: 'Example',
      runDir: dir,
      runKind: 'lead',
      scannedAt: null,
      checkedAt,
      pagesScanned: 1,
      requestsSent: { scan: null, gate: 2 },
      stack: null,
      fitScore: null,
      control: { homepage: 200, randomMissing: 404, blocked: false, statusUnreliable: false, note: null },
      highlights,
      causes: highlights.map((h) => h.rootCause),
      teaserReady: false,
      candidatesDropped: dropped,
      disclosure: [],
      runStamp: gateRunStamp(checkedAt),
    });
    const first = base('2026-11-17T10:00:00.000Z', [
      highlight('noindex', 'A'),
      highlight('unnamed-controls', 'B', 'unnamed-controls'),
    ]);
    writeLeadFile(first);
    assert.equal(first.previous, null);
    const second = base(
      '2026-11-18T10:00:00.000Z',
      [highlight('noindex', 'A'), highlight('missing-page-status', 'C')],
      [
        {
          type: 'unnamed-controls',
          reason: 'second-method-disagrees',
          rootCause: 'unnamed-controls',
          detail: 'the browser names it',
        },
      ],
    );
    writeLeadFile(second);

    assert.deepEqual(listGateRuns(dir), ['2026-11-17T10-00-00-000Z.json', '2026-11-18T10-00-00-000Z.json']);
    const latest = readLeadFile(dir)!;
    assert.equal(latest.checkedAt, '2026-11-18T10:00:00.000Z');
    assert.equal(latest.previous?.file, path.join('gate-runs', '2026-11-17T10-00-00-000Z.json'));
    assert.deepEqual(
      latest.previous?.changes.map((c) => [c.rootCause, c.change]),
      [
        ['noindex', 'confirmed'],
        ['missing-page-status', 'new'],
        ['unnamed-controls', 'gone'],
      ],
    );
    assert.equal(latest.previous?.changes[2]?.reason, 'second-method-disagrees: the browser names it');
    const kept = JSON.parse(
      fs.readFileSync(path.join(leadDir(dir), 'gate-runs', '2026-11-17T10-00-00-000Z.json'), 'utf8'),
    ) as LeadFile;
    assert.deepEqual(kept.causes, ['noindex', 'unnamed-controls'], 'the earlier run is intact');
  });

  void it('files a lead.json from before runs were kept, and compares wording without the random address', () => {
    const dir = tmp();
    fs.mkdirSync(leadDir(dir), { recursive: true });
    const legacy = {
      checkedAt: '2026-11-16T08:00:00.000Z',
      highlights: [highlight('missing-page-status', 'An address (/lead-check-abc123) answers 200')],
      candidatesDropped: [],
    };
    fs.writeFileSync(path.join(leadDir(dir), 'lead.json'), JSON.stringify(legacy));
    assert.deepEqual(listGateRuns(dir), []);
    const changes = compareGateRuns(legacy as unknown as LeadFile, {
      highlights: [
        highlight('missing-page-status', 'An address (/lead-check-zz9) answers 200'),
        highlight('noindex', 'now 3 pages'),
      ],
      candidatesDropped: [],
    });
    assert.deepEqual(
      changes.map((c) => c.change),
      ['confirmed', 'new'],
    );
    const changed = compareGateRuns(
      { highlights: [highlight('noindex', '2 pages')] },
      { highlights: [highlight('noindex', '3 pages')], candidatesDropped: [] },
    );
    assert.deepEqual(changed, [
      { rootCause: 'noindex', type: 'noindex', change: 'changed', before: '2 pages', after: '3 pages' },
    ]);
  });
});
