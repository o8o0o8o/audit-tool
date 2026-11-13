/**
 * The review page: one card per prospect that has a teaser waiting, with every highlight, its
 * evidence and what the gate left out. A static HTML file; verdicts are recorded with the
 * `approve` / `reject` commands shown on each card.
 */

import * as path from 'node:path';
import type { LeadFile } from './lead-file';
import { shortLabel, stackLine, whyItMatters } from './teaser';

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const link = (url: string) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;

export interface ReviewCard {
  lead: LeadFile;
  stage: string;
  /** `pending` when a disclosure must be sent before outreach. */
  disclosed: string;
}

function card({ lead, stage, disclosed }: ReviewCard, pageDir: string): string {
  const base = path.relative(pageDir, path.join(lead.runDir, 'lead'));
  const stack = stackLine(lead);
  const top = lead.highlights.slice(0, 3);
  const dropped = lead.candidatesDropped.filter((d) => d.reason !== 'not-on-allowlist');
  const notUsed = lead.candidatesDropped.filter((d) => d.reason === 'not-on-allowlist');

  const highlights = top
    .map((h, i) => {
      const e = h.evidence;
      const shot = e.screenshot ? `<img src="${esc(path.join(base, e.screenshot))}" alt="">` : '';
      const rows = [
        ['Open', link(h.url)],
        ...(e.target ? [['Target', link(e.target)]] : []),
        ...(e.status != null ? [['Status seen', esc(e.status)]] : []),
        ...(e.value != null ? [['Value', esc(e.value)]] : []),
        ['Confirmed by', esc(e.methods.join(' + '))],
        ['Control', `homepage ${esc(e.control.homepage)}, random missing URL ${esc(e.control.randomMissing)}`],
        ...(e.source ? [['Source', esc(e.source)]] : []),
        ...(e.also?.length ? [['Also', `${e.also.length} more: ${e.also.slice(0, 5).map(esc).join(', ')}`]] : []),
        ['Checked', esc(e.checkedAt)],
      ];
      return `<li><h3>${i + 1}. ${esc(h.fact)}.</h3>
        <p class="why">${esc(whyItMatters(h))}</p>
        <table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>${shot}
        <p class="tags"><span>${esc(h.type)}</span><span>${esc(h.rootCause)}</span><span>${esc(shortLabel(h))}</span></p></li>`;
    })
    .join('');

  const warning =
    disclosed === 'pending'
      ? `<p class="block">A security exposure was found on this site (${esc(lead.disclosure.map((d) => d.check).join(', '))}). Disclose it first; no outreach until then.</p>`
      : '';

  return `<article id="${esc(lead.domain)}">
    <header><h2>${esc(lead.company)} <small>${esc(lead.domain)}</small></h2>
      <p>${esc(stage)} · fit ${esc(lead.fitScore ?? '–')} · ${esc(lead.track ?? '–')} · ${esc(lead.pagesScanned)} pages read · ${esc(lead.requestsSent.scan ?? '?')} + ${esc(lead.requestsSent.gate)} requests · ${esc(lead.runKind)} run</p>
      <p>${stack ? `Stack line on the teaser: <strong>${esc(stack)}</strong>` : `No stack line (confidence ${esc(lead.stack?.confidence ?? 'n/a')}): ${esc([lead.stack?.cms, lead.stack?.framework].filter(Boolean).join(', ') || 'unknown')}`}</p>
    </header>${warning}
    <ol>${highlights}</ol>
    <details><summary>Checked and dropped (${dropped.length})</summary><ul>${dropped.map((d) => `<li><code>${esc(d.type)}</code> ${esc(d.reason)}${d.detail ? ` — ${esc(d.detail)}` : ''}</li>`).join('') || '<li>none</li>'}</ul></details>
    <details><summary>Audit findings left for the full audit (${notUsed.length})</summary><ul>${notUsed.map((d) => `<li>${esc(d.type)} <em>(${esc(d.detail)})</em></li>`).join('') || '<li>none</li>'}</ul></details>
    <p class="files"><a href="${esc(path.join(base, 'teaser.pdf'))}">teaser.pdf</a> · <a href="${esc(path.join(base, 'email.md'))}">email.md</a> · <a href="${esc(path.join(base, 'lead.json'))}">lead.json</a></p>
    <pre>npx tsx scripts/lead-pipeline.ts approve ${esc(lead.domain)}
npx tsx scripts/lead-pipeline.ts reject ${esc(lead.domain)} --highlight=1 --reason="…" [--factual]</pre>
  </article>`;
}

export function buildReviewPage(
  cards: ReviewCard[],
  pageDir: string,
  generatedAt: string = new Date().toISOString(),
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lead teasers to review</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --ink: #14181d; --muted: #5b6470; --rule: #d5dae0; --accent: #00a651; --warn: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0e1116; --card: #161b22; --ink: #e6edf3; --muted: #9aa4af; --rule: #2b323b; --accent: #00e56d; --warn: #ff7b72; } }
  body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--ink); font: 15px/1.5 Inter, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 0; } h2 small { color: var(--muted); font-weight: 400; }
  h3 { font-size: 15px; margin: 0 0 4px; }
  article { background: var(--card); border: 1px solid var(--rule); border-radius: 10px; padding: 18px 20px; margin: 18px 0; }
  header p, .why, .files, .intro { color: var(--muted); margin: 2px 0; }
  ol { padding-left: 0; list-style: none; } ol li { border-top: 1px solid var(--rule); padding: 12px 0; }
  table { border-collapse: collapse; margin: 6px 0; font-size: 13px; } th { text-align: left; color: var(--muted); font-weight: 500; padding: 1px 12px 1px 0; vertical-align: top; white-space: nowrap; } td { overflow-wrap: anywhere; }
  img { max-width: 100%; border: 1px solid var(--rule); border-radius: 6px; margin: 6px 0; }
  a { color: var(--accent); } .tags span { display: inline-block; font-size: 12px; color: var(--muted); border: 1px solid var(--rule); border-radius: 99px; padding: 0 8px; margin-right: 6px; }
  .block { color: var(--warn); font-weight: 600; } details { margin: 6px 0; font-size: 13px; } summary { cursor: pointer; color: var(--muted); }
  pre { background: var(--bg); border: 1px solid var(--rule); border-radius: 6px; padding: 8px 10px; font-size: 12px; overflow-x: auto; }
</style></head><body><main>
<h1>Lead teasers to review</h1>
<p class="intro">${cards.length} prospect${cards.length === 1 ? '' : 's'} · generated ${esc(generatedAt.slice(0, 16).replace('T', ' '))} UTC. Open each address and confirm the fact before approving. A verdict is per highlight; reject with <code>--factual</code> when the fact itself is wrong.</p>
${cards.map((c) => card(c, pageDir)).join('\n') || '<p>No teaser is waiting for review.</p>'}
</main></body></html>`;
}
