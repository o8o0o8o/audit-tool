/**
 * Head integrity: finds the first element in the served (pre-JavaScript) HTML
 * head that the HTML parser does not allow there. The parser closes the head
 * at that element, so every canonical, hreflang or robots tag after it lands
 * in the body, where Google ignores it.
 *
 * <noscript> in the head is parsed as with scripting disabled (Googlebot's
 * initial HTML pass): only link/meta/style may appear inside it.
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';

const HEAD_ELEMENTS = new Set(['title', 'meta', 'link', 'style', 'script', 'base', 'noscript', 'template']);
const NOSCRIPT_HEAD_ELEMENTS = new Set(['link', 'meta', 'style']);
const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea', 'template']);

export interface HeadBreak {
  /** Tag (or "text") that closed the head. */
  breaker: string;
  /** Snippet of the offending markup. */
  snippet: string;
  /** SEO-critical tags that appear after the break and so end up in the body. */
  displaced: string[];
}

function describeCritical(tag: string, attrs: string): string | null {
  const a = attrs.toLowerCase();
  if (tag === 'link' && /\brel\s*=\s*["']?canonical\b/.test(a)) return 'canonical';
  if (tag === 'link' && /\bhreflang\s*=/.test(a)) return 'hreflang';
  if (tag === 'meta' && /\bname\s*=\s*["']?(?:robots|googlebot)\b/.test(a)) return 'robots meta';
  if (tag === 'meta' && /\bname\s*=\s*["']?description\b/.test(a)) return 'meta description';
  if (tag === 'title') return 'title';
  return null;
}

/** Returns where the head closes early, or null when the head is valid. */
export function findHeadBreak(html: string): HeadBreak | null {
  const headOpen = /<head\b[^>]*>/i.exec(html);
  if (!headOpen) return null;
  const start = headOpen.index + headOpen[0].length;
  const tagRe = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  tagRe.lastIndex = start;
  let pos = start;
  let inNoscript = false;
  let brk: { breaker: string; snippet: string; at: number } | null = null;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(html))) {
    const between = html.slice(pos, m.index);
    if (!brk && between.trim() && !inNoscript) {
      brk = { breaker: 'text', snippet: between.trim().slice(0, 60), at: pos };
    }
    pos = tagRe.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    const tag = m[1].toLowerCase();
    const closing = m[0][1] === '/';
    if (closing) {
      if (tag === 'head') break;
      if (tag === 'noscript') inNoscript = false;
      continue;
    }
    if (tag === 'body' || tag === 'html') break;
    if (RAW_TEXT.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, pos);
      if (end > -1) {
        tagRe.lastIndex = pos = end;
      }
    }
    if (brk) continue;
    if (inNoscript ? !NOSCRIPT_HEAD_ELEMENTS.has(tag) : !HEAD_ELEMENTS.has(tag)) {
      brk = { breaker: inNoscript ? `${tag} inside noscript` : tag, snippet: m[0].slice(0, 80), at: m.index };
    }
    if (tag === 'noscript') inNoscript = true;
  }
  if (!brk) return null;

  // SEO tags written after the break, up to the end of the source head section.
  const headEnd = (() => {
    const i = html.toLowerCase().indexOf('</head', brk.at);
    return i > -1 ? i : Math.min(html.length, brk.at + 50000);
  })();
  const tail = html.slice(brk.at, headEnd);
  const displaced = new Set<string>();
  for (const t of tail.matchAll(/<(link|meta|title)\b([^>]*)>/gi)) {
    const d = describeCritical(t[1].toLowerCase(), t[2]);
    if (d) displaced.add(d);
  }
  return { breaker: brk.breaker, snippet: brk.snippet, displaced: [...displaced] };
}

export class HeadIntegrityAnalyzer {
  static analyze(servedHtml: string | undefined) {
    const issues: Issue[] = [];
    if (!servedHtml) return { issues, warnings: [] as Issue[], info: null };
    const found = findHeadBreak(servedHtml);
    if (!found) return { issues, warnings: [] as Issue[], info: { valid: true } };
    const snippet = found.snippet.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const where =
      found.breaker === 'text'
        ? 'stray text'
        : `a <${found.breaker.split(' ')[0]}> element${found.breaker.includes('noscript') ? ' inside noscript' : ''}`;
    if (found.displaced.length) {
      const critical = found.displaced.some((d) => d === 'canonical' || d === 'hreflang' || d === 'robots meta');
      issues.push({
        message: 'Invalid element in HTML head hides SEO tags',
        detail: `The served HTML head contains ${where.replace(/</g, '&lt;').replace(/>/g, '&gt;')} (<code>${snippet}</code>), which ends the head early. These tags after it move into the body and search engines may ignore them: ${found.displaced.join(', ')}. Move the element into the body or below the SEO tags.`,
        severity: critical ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      });
    } else {
      issues.push({
        message: 'Invalid element in HTML head closes it early',
        detail: `The served HTML head contains ${where.replace(/</g, '&lt;').replace(/>/g, '&gt;')} (<code>${snippet}</code>), which ends the head early. No SEO tags follow it yet, but any added later would be ignored. Move it into the body.`,
        severity: SEVERITY.LOW,
      });
    }
    return { issues, warnings: [] as Issue[], info: { valid: false, ...found } };
  }
}
