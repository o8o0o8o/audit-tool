/**
 * What Chrome itself reports about a page in its DevTools "Issues" panel (CDP `Audits.issueAdded`):
 * requests the browser refused because of CORS, resources the site's own Content Security Policy
 * blocked, stylesheets that failed to load, a page rendered in quirks mode, and deprecated features.
 *
 * These are the browser's verdicts, not heuristics: each names the request or the element. Cookie
 * phase-out warnings and advertising-API notices are left out; they say nothing is broken.
 */

import { SEVERITY } from '../../constants';
import type { ChromePage, Issue } from '../../types';

export const CORS_BLOCKED_MESSAGE = 'Requests blocked by the browser (CORS)';
export const CSP_BLOCKED_MESSAGE = "Resources blocked by the site's own Content Security Policy";
export const STYLESHEET_FAILED_MESSAGE = 'Stylesheet failed to load';
export const QUIRKS_MODE_MESSAGE = 'Page renders in quirks mode';
export const DEPRECATED_FEATURE_MESSAGE = 'Page uses browser features that are deprecated';

export const BROWSER_ISSUE_MESSAGES = [
  CORS_BLOCKED_MESSAGE,
  CSP_BLOCKED_MESSAGE,
  STYLESHEET_FAILED_MESSAGE,
  QUIRKS_MODE_MESSAGE,
  DEPRECATED_FEATURE_MESSAGE,
] as const;

/** One issue, reduced to what a finding needs. */
export interface BrowserIssue {
  kind: 'cors' | 'csp' | 'stylesheet' | 'quirks' | 'deprecation';
  /** The request, stylesheet or document concerned; the deprecated feature's name for a deprecation. */
  subject: string;
  /** Chrome's own reason code, e.g. `MissingAllowOriginHeader`, `kURLViolation: script-src`. */
  reason: string;
}

type Raw = { code?: string; details?: Record<string, Record<string, unknown> | undefined> };
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Maps a raw CDP issue to a `BrowserIssue`; null for kinds that are not reported. */
export function readBrowserIssue(raw: unknown): BrowserIssue | null {
  const issue = (raw ?? {}) as Raw;
  const d = issue.details ?? {};
  switch (issue.code) {
    case 'CorsIssue': {
      const c = d.corsIssueDetails ?? {};
      if (c.isWarning === true) return null;
      const subject = str((c.request as { url?: string } | undefined)?.url);
      const reason = str((c.corsErrorStatus as { corsError?: string } | undefined)?.corsError);
      return subject ? { kind: 'cors', subject, reason } : null;
    }
    case 'ContentSecurityPolicyIssue': {
      const c = d.contentSecurityPolicyIssueDetails ?? {};
      // A report-only policy blocks nothing.
      if (c.isReportOnly === true) return null;
      const type = str(c.contentSecurityPolicyViolationType);
      if (!/^k(?:URL|Inline|Eval|WasmEval)Violation$/.test(type)) return null;
      // `frame-ancestors` is the policy of the page being framed, not of the page that frames it.
      if (/^frame-ancestors/i.test(str(c.violatedDirective))) return null;
      const subject =
        str(c.blockedURL) || (type === 'kInlineViolation' ? 'an inline script or style' : 'a script that uses eval');
      return { kind: 'csp', subject, reason: `${type.replace(/^k|Violation$/g, '')}: ${str(c.violatedDirective)}` };
    }
    case 'StylesheetLoadingIssue': {
      const c = d.stylesheetLoadingIssueDetails ?? {};
      const reason = str(c.styleSheetLoadingIssueReason);
      const subject =
        str((c.failedRequestInfo as { url?: string } | undefined)?.url) ||
        str((c.sourceCodeLocation as { url?: string } | undefined)?.url);
      // A late @import is a performance note; a failed request is a missing stylesheet.
      return reason === 'RequestFailed' && subject ? { kind: 'stylesheet', subject, reason } : null;
    }
    case 'QuirksModeIssue': {
      const c = d.quirksModeIssueDetails ?? {};
      return c.isLimitedQuirksMode === true ? null : { kind: 'quirks', subject: str(c.url), reason: 'QuirksMode' };
    }
    case 'DeprecationIssue': {
      const c = d.deprecationIssueDetails ?? {};
      const type = str(c.type);
      const subject = str((c.sourceCodeLocation as { url?: string } | undefined)?.url);
      return type ? { kind: 'deprecation', subject: type, reason: subject } : null;
    }
    default:
      return null;
  }
}

const SAMPLE = 4;
const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};
const short = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n)}…` : s);

function sample(items: string[]): string {
  const unique = [...new Set(items)];
  const shown = unique.slice(0, SAMPLE).map((s) => short(s));
  return `${shown.join(', ')}${unique.length > SAMPLE ? ` (+${unique.length - SAMPLE} more)` : ''}`;
}

/**
 * Findings for one page. A quirks-mode or stylesheet issue in a third-party frame (an embedded
 * player, an ad) is not the page's own defect and is left out.
 */
export function browserIssueFindings(issues: BrowserIssue[], url: string): Issue[] {
  const link = `<a href="${url}">${url}</a>`;
  const site = host(url).replace(/^www\./, '');
  const own = (subject: string) => {
    const h = host(subject).replace(/^www\./, '');
    return !h || h === site || h.endsWith(`.${site}`) || site.endsWith(`.${h}`);
  };
  const of = (kind: BrowserIssue['kind']) => issues.filter((i) => i.kind === kind);
  const out: Issue[] = [];

  const cors = of('cors');
  if (cors.length > 0) {
    out.push({
      severity: SEVERITY.MEDIUM,
      message: CORS_BLOCKED_MESSAGE,
      detail: `${link}: the browser refused ${new Set(cors.map((i) => i.subject)).size} request(s) the page made, because the answering server does not allow this site to read them (${sample(cors.map((i) => i.reason).filter(Boolean)) || 'CORS'}): ${sample(cors.map((i) => i.subject))}`,
    });
  }
  const csp = of('csp');
  if (csp.length > 0) {
    out.push({
      severity: SEVERITY.MEDIUM,
      message: CSP_BLOCKED_MESSAGE,
      detail: `${link}: the page's Content Security Policy blocked ${csp.length} resource load(s) or script(s) that the page itself asks for (${sample(csp.map((i) => i.reason))}): ${sample(csp.map((i) => i.subject))}`,
    });
  }
  const sheets = of('stylesheet');
  if (sheets.length > 0) {
    out.push({
      severity: SEVERITY.MEDIUM,
      message: STYLESHEET_FAILED_MESSAGE,
      detail: `${link}: ${new Set(sheets.map((i) => i.subject)).size} stylesheet(s) the page links to could not be loaded: ${sample(sheets.map((i) => i.subject))}`,
    });
  }
  if (of('quirks').some((i) => !i.subject || own(i.subject))) {
    out.push({
      severity: SEVERITY.MEDIUM,
      message: QUIRKS_MODE_MESSAGE,
      detail: `${link} has no valid doctype at the start of its HTML, so browsers lay it out with 1990s rules (quirks mode); sizes and box layout then differ from what the CSS says`,
    });
  }
  const deprecated = of('deprecation');
  if (deprecated.length > 0) {
    out.push({
      severity: SEVERITY.LOW,
      message: DEPRECATED_FEATURE_MESSAGE,
      detail: `${link} uses ${new Set(deprecated.map((i) => i.subject)).size} feature(s) Chrome has announced it will remove: ${sample(deprecated.map((i) => i.subject))}`,
    });
  }
  return out;
}

/** Listens for the browser's issues on a page. Start it before navigation. */
export async function trackBrowserIssues(
  page: ChromePage,
): Promise<{ results: () => BrowserIssue[]; cleanup: () => Promise<void> }> {
  const found: BrowserIssue[] = [];
  try {
    const session = await page.context().newCDPSession(page);
    session.on('Audits.issueAdded', (event: { issue: unknown }) => {
      if (found.length >= 400) return;
      const issue = readBrowserIssue(event.issue);
      if (issue) found.push(issue);
    });
    await session.send('Audits.enable');
    return { results: () => found, cleanup: () => session.detach().catch(() => undefined) };
  } catch {
    // not a Chromium page, or the session could not be opened: no issues, no finding
    return { results: () => found, cleanup: async () => undefined };
  }
}
