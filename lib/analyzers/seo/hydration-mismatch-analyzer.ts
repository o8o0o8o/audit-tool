/**
 * Hydration mismatch: the served (pre-JS) HTML and the rendered DOM both carry
 * an SEO tag but with different values. Search engines may index either one
 * (the first crawl wave sees the served HTML), so a disagreement means the
 * indexed title / canonical / robots directive depends on whether JS ran.
 *
 * Tags present only after JS are covered by javascript-rendering-analyzer;
 * this module only reports tags present in BOTH versions with different values.
 */

import { parse, type HTMLElement } from 'node-html-parser';
import { SEVERITY } from '../../constants';
import type { Issue, SeverityLevel } from '../../types';
import { escapeHtml } from '../../reports/html-utils';

export const HYDRATION_MISMATCH_MESSAGE = 'Server and rendered HTML disagree on SEO tags';

export type SeoTagName = 'title' | 'description' | 'canonical' | 'robots' | 'h1';

export type SeoTags = Partial<Record<SeoTagName, string>>;

export interface TagMismatch {
  tag: SeoTagName;
  served: string;
  rendered: string;
}

const TAG_SEVERITY: Record<SeoTagName, SeverityLevel> = {
  canonical: SEVERITY.HIGH,
  robots: SEVERITY.HIGH,
  title: SEVERITY.MEDIUM,
  description: SEVERITY.MEDIUM,
  h1: SEVERITY.MEDIUM,
};

const TAG_LABEL: Record<SeoTagName, string> = {
  title: '&lt;title&gt;',
  description: 'meta description',
  canonical: 'canonical link',
  robots: 'meta robots',
  h1: 'first H1',
};

/** Decode entities via the parser, collapse whitespace. */
function clean(value: string | undefined | null): string | undefined {
  if (value == null) return undefined;
  const decoded = parse(`<b>${value.replace(/</g, '&lt;')}</b>`).text;
  return decoded.replace(/[\s\u00a0]+/g, ' ').trim();
}

function metaContent(root: HTMLElement, name: string): string | undefined {
  for (const m of root.querySelectorAll('meta[name]')) {
    if ((m.getAttribute('name') ?? '').trim().toLowerCase() === name) return m.getAttribute('content') ?? '';
  }
  return undefined;
}

/** Extract the compared SEO tags from an HTML string. Missing tags are omitted. */
export function extractSeoTags(html: string, pageUrl?: string): SeoTags {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false } });
  const tags: SeoTags = {};
  const title = root.querySelector('title');
  if (title) tags.title = clean(title.text);
  const desc = metaContent(root, 'description');
  if (desc !== undefined) tags.description = clean(desc);
  const robots = metaContent(root, 'robots');
  if (robots !== undefined) tags.robots = clean(robots);
  const canonical = root
    .querySelectorAll('link[rel]')
    .find((l) => (l.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical'));
  const href = canonical?.getAttribute('href');
  if (href != null) {
    let abs = clean(href) ?? '';
    try {
      if (pageUrl) abs = new URL(abs, pageUrl).href;
    } catch {
      /* keep raw */
    }
    tags.canonical = abs;
  }
  const h1 = root.querySelector('h1');
  if (h1) tags.h1 = clean(h1.text);
  return tags;
}

function comparable(tag: SeoTagName, v: string): string {
  if (tag === 'robots')
    return v
      .toLowerCase()
      .split(/\s*,\s*/)
      .filter(Boolean)
      .sort()
      .join(',');
  if (tag === 'canonical') return v; // URL case is significant (path), already absolutised
  return v.toLowerCase();
}

/** Pure: tags present in both versions whose values differ (ignoring whitespace/case). */
export function compareSeoTags(served: SeoTags, rendered: SeoTags): TagMismatch[] {
  const out: TagMismatch[] = [];
  for (const tag of ['canonical', 'robots', 'title', 'description', 'h1'] as SeoTagName[]) {
    const s = served[tag];
    const r = rendered[tag];
    if (s === undefined || r === undefined) continue;
    if (comparable(tag, s) !== comparable(tag, r)) out.push({ tag, served: s, rendered: r });
  }
  return out;
}

const clip = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}...` : s);

/** One issue per severity level (HIGH for canonical/robots, MEDIUM otherwise). */
export function hydrationMismatchIssues(mismatches: TagMismatch[]): Issue[] {
  const issues: Issue[] = [];
  for (const severity of [SEVERITY.HIGH, SEVERITY.MEDIUM]) {
    const group = mismatches.filter((m) => TAG_SEVERITY[m.tag] === severity);
    if (group.length === 0) continue;
    const parts = group.map(
      (m) =>
        `${TAG_LABEL[m.tag]}: served "${escapeHtml(clip(m.served))}" but rendered "${escapeHtml(clip(m.rendered))}"`,
    );
    issues.push({
      message: HYDRATION_MISMATCH_MESSAGE,
      detail: `${parts.join('; ')}. Search engines may index the served value (first crawl pass, non-JS crawlers, link previews) or the rendered one, so the page's indexed signals depend on whether JavaScript ran. Make the server render the final value.`,
      severity,
    });
  }
  return issues;
}

export class HydrationMismatchAnalyzer {
  static analyze(servedHtml: string | undefined, renderedHtml: string | undefined, pageUrl?: string) {
    if (!servedHtml || !renderedHtml)
      return { issues: [] as Issue[], warnings: [] as Issue[], info: { mismatches: [] } };
    let mismatches: TagMismatch[];
    try {
      mismatches = compareSeoTags(extractSeoTags(servedHtml, pageUrl), extractSeoTags(renderedHtml, pageUrl));
    } catch {
      mismatches = [];
    }
    return { issues: hydrationMismatchIssues(mismatches), warnings: [] as Issue[], info: { mismatches } };
  }
}
