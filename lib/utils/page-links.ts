/**
 * Page lists for site-level finding details. A finding that says "N pages …"
 * names them: the reports turn each `<a href="https://…">` back into a link
 * (`exampleHtml`), and the reader can open the pages to check the claim.
 */

const DEFAULT_MAX = 10;

function link(url: string): string {
  // Only http(s) URLs become links; the reports escape everything else.
  const href = url.replace(/"/g, '%22').replace(/[<>\s]/g, encodeURIComponent);
  return /^https?:\/\//i.test(href) ? `<a href="${href}">${href}</a>` : href;
}

/** `<a>`, `<a>`, … and N more — the first `max` unique URLs, in the given order. */
export function pageLinks(urls: Iterable<string>, max = DEFAULT_MAX): string {
  const unique = [...new Set(Array.from(urls).filter(Boolean))];
  if (unique.length === 0) return '';
  const shown = unique.slice(0, max).map(link).join(', ');
  const rest = unique.length - max;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/** ` Label: <links>.` to append to a detail, or '' when there are no URLs. */
export function withPages(label: string, urls: Iterable<string>, max = DEFAULT_MAX): string {
  const list = pageLinks(urls, max);
  return list ? ` ${label}: ${list}.` : '';
}
