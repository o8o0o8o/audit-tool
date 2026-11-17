/**
 * Stage 6 of the lead pipeline: the teaser — one page with three confirmed problems and an email
 * draft that offers a call. Built from `lead.json` alone; nothing here makes a request.
 *
 * Rules (docs/gtm/sales-audit-system.md, "Stage 6: teaser"):
 *  - three highlights, three different root causes, in the gate's order;
 *  - every highlight carries its evidence: an address to open, and a screenshot where one shows it;
 *  - the page count is the number of pages really read;
 *  - no stack line: the teaser is about the site's problems, not its platform (the stack stays on
 *    the review card for the reviewer and the call);
 *  - no score, and no count of "further issues";
 *  - facts are stated side by side; no sentence claims a cause.
 *
 * Wording here is fixed templates. An LLM may later rephrase the "why it matters" lines and the
 * email, but it never decides anything and its text is validated against the facts.
 */

import * as fs from 'node:fs';
import type { LeadFile } from './lead-file';
import type { Highlight } from './truth-gate';

export interface TeaserConfig {
  agency: string;
  sender: string;
  calendarUrl: string;
  callMinutes: number;
  optOut: string;
}

export const DEFAULT_TEASER_CONFIG_PATH = 'docs/gtm/teaser-config.json';
export const DEFAULT_TEASER_CONFIG: TeaserConfig = {
  agency: 'FocusReactive',
  sender: '',
  calendarUrl: '',
  callMinutes: 20,
  optOut: 'If this is not useful, reply "no thanks" and we will not write again.',
};

export function loadTeaserConfig(file: string = DEFAULT_TEASER_CONFIG_PATH): TeaserConfig {
  if (!fs.existsSync(file)) return DEFAULT_TEASER_CONFIG;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TeaserConfig>;
  return {
    agency: typeof raw.agency === 'string' && raw.agency ? raw.agency : DEFAULT_TEASER_CONFIG.agency,
    sender: typeof raw.sender === 'string' ? raw.sender : '',
    calendarUrl: typeof raw.calendarUrl === 'string' ? raw.calendarUrl : '',
    callMinutes:
      typeof raw.callMinutes === 'number' && raw.callMinutes > 0 ? raw.callMinutes : DEFAULT_TEASER_CONFIG.callMinutes,
    optOut: typeof raw.optOut === 'string' && raw.optOut ? raw.optOut : DEFAULT_TEASER_CONFIG.optOut,
  };
}

export const TEASER_HIGHLIGHTS = 3;

/** Words that claim a cause. Nothing in the pipeline can verify "because", so no teaser text may say it. */
const CAUSAL =
  /\b(?:because|due to|caused by|as a result of|owing to|thanks to|results? from|leads? to|which is why|that is why)\b/i;

export function hasCausalWording(text: string): boolean {
  return CAUSAL.test(text);
}

/** One sentence per root cause, in business terms. General statements only: nothing about this site's causes. */
export function whyItMatters(h: Highlight): string {
  if (h.rootCause.startsWith('end-of-life')) {
    return 'No security or compatibility fixes are released for this version any more, and each month adds known issues that will never be patched.';
  }
  switch (h.rootCause) {
    case 'language-switch':
      return 'A visitor who chooses that language gets an error page and not the content.';
    case 'dead-navigation-links':
      return "A visitor who follows the site's own navigation gets an error page.";
    case 'broken-images':
      return 'Visitors see an empty frame where the picture should be.';
    case 'real-user-performance':
      return 'Google records this from real Chrome users and uses it in its page experience assessment; it is also what visitors on phones feel.';
    case 'noindex':
      return "A page that carries this instruction is left out of Google's results.";
    case 'template-text':
      return 'Every visitor of the page sees it where the real content should be.';
    case 'missing-hreflang':
      return 'Hreflang tags tell Google which language version to show to whom; without them a visitor can land on a page in the wrong language.';
    case 'sitemap-dead-urls':
      return 'The sitemap is the list of pages a site asks search engines to crawl; an address on it that is gone sends their crawl to an error page.';
    case 'vulnerable-libraries':
      return 'The advisory is public, and security scanners flag every site that still loads an affected version.';
    case 'analytics-data-loss':
      return 'Campaign reports, conversion figures and ad bidding are built from these numbers, and data that was never sent cannot be recovered later.';
    case 'email-authentication':
      return 'Gmail, Yahoo and Microsoft read SPF and DMARC to decide whether a message really comes from the domain it names, and since 2024 they require both from anyone sending mail in bulk.';
    case 'tracking-before-consent':
      return "Where the GDPR and the ePrivacy rules apply, analytics and advertising cookies may be set only after the visitor agrees, so the banner's question comes after the fact.";
    case 'unnamed-controls':
      return 'Screen readers and voice control use these names; without one, a visitor who cannot see the page cannot tell what the control does. A missing name fails WCAG 2.1 criterion 4.1.2, the standard the European Accessibility Act refers to.';
    default:
      return 'It is visible to every visitor of the page.';
  }
}

/** Short label for the email line and the review page. */
export function shortLabel(h: Highlight): string {
  if (h.rootCause.startsWith('end-of-life'))
    return `software past its end of life (${String(h.evidence.value ?? '')})`.replace(' ()', '');
  switch (h.rootCause) {
    case 'language-switch':
      return 'a language link that returns an error';
    case 'dead-navigation-links':
      return 'navigation links that return an error';
    case 'broken-images':
      return 'images that do not load';
    case 'real-user-performance':
      return 'real-user experience figures in Google\'s "poor" range';
    case 'noindex':
      return 'a key page hidden from search engines';
    case 'template-text':
      return 'placeholder text or raw template code on a live page';
    case 'missing-hreflang':
      return 'language versions that search engines are not told about';
    case 'sitemap-dead-urls':
      return 'sitemap addresses that return an error';
    case 'analytics-data-loss':
      return 'analytics data the site never sends';
    case 'email-authentication':
      return 'email authentication records (SPF/DMARC) that mail servers cannot rely on';
    case 'tracking-before-consent':
      return 'tracking cookies set before the visitor answers the cookie banner';
    case 'unnamed-controls':
      return 'buttons or links a screen reader cannot name';
    case 'vulnerable-libraries':
      return `a script library with a published security advisory (${String(h.evidence.value ?? '')})`.replace(
        ' ()',
        '',
      );
    default:
      return h.type;
  }
}

function whereLines(h: Highlight): string[] {
  const target = h.evidence.target;
  switch (h.type) {
    case 'dead-nav-link':
      return [`**Where:** <${h.url}>`, ...(target ? [`**The link goes to:** <${target}>`] : [])];
    case 'broken-image':
      return [`**Where:** <${h.url}>`, ...(target ? [`**The image file:** <${target}>`] : [])];
    case 'poor-vitals':
      return [`**Check it yourself:** <${h.url}>`, ...(h.evidence.source ? [`**Source:** ${h.evidence.source}`] : [])];
    case 'end-of-life':
      return [`**Reference:** <${h.url}>`];
    case 'vulnerable-library':
      return [`**Where:** <${h.url}>`, ...(target ? [`**The script file:** <${target}>`] : [])];
    case 'missing-hreflang':
      return [`**Where:** <${h.url}>`, ...(target ? [`**Another language version:** <${target}>`] : [])];
    case 'email-auth':
      return [
        `**Check it yourself:** look up the TXT records of ${target ?? 'the domain'} and _dmarc.${target ?? 'the domain'} in any DNS lookup tool.`,
      ];
    case 'analytics-gap':
      return [
        `**Where:** <${h.url}>`,
        "**Check it yourself:** open the page with the browser's developer tools on the Network tab and filter for `collect` (Google Analytics hits) or `gtm.js` (Tag Manager).",
      ];
    case 'tracking-before-consent':
      return [
        `**Where:** <${h.url}>`,
        "**Check it yourself:** open the page in a private window, leave the cookie banner unanswered and look at the cookies in the browser's developer tools (Application → Cookies).",
      ];
    case 'unnamed-controls':
      return [
        `**Where:** <${h.url}>`,
        '**Check it yourself:** in Chrome, right-click the control, choose Inspect and open the Accessibility pane: its Name is empty.',
      ];
    case 'sitemap-dead-urls': {
      const more = (h.evidence.also ?? []).slice(0, 2);
      return [`**For example:** <${h.url}>`, ...more.map((u) => `**Also:** <${u}>`)];
    }
    default:
      return [`**Where:** <${h.url}>`];
  }
}

/**
 * `Concrete CMS and Contentful`, `Contentful with a Next.js front end`; null unless confidence is high.
 * For the review card only: the teaser never names the platform.
 */
export function stackLine(lead: LeadFile): string | null {
  const s = lead.stack;
  if (s?.confidence !== 'high' || (!s.cms && !s.framework)) return null;
  const cms = s.cms ? `${s.cms}${s.cmsVersion && s.cmsVersionConfirmed ? ` ${s.cmsVersion}` : ''}` : null;
  const parts = [cms, s.cmsSecondary].filter(Boolean).join(' and ');
  // The front end is named for headless and custom-built sites, where it is the stack.
  const frontEnd = s.framework && ['headless', 'custom'].includes(s.kind) ? s.framework : null;
  if (parts && frontEnd) return `${parts} with a ${frontEnd} front end`;
  return parts || frontEnd;
}

const dateOnly = (iso: string | null | undefined) => (iso ?? '').slice(0, 10);

export interface Teaser {
  /** The highlights shown, at most three. */
  highlights: Highlight[];
  markdown: string;
  email: string;
  subject: string;
}

export class TeaserError extends Error {}

export function buildTeaser(lead: LeadFile, config: TeaserConfig = DEFAULT_TEASER_CONFIG): Teaser {
  if (lead.disclosure.length) {
    // The caller decides whether the disclosure has been sent; this is the last line of defence.
    throw new TeaserError(
      'a security exposure was found on this site: disclose it first (lead-pipeline.ts disclosed <domain>)',
    );
  }
  const seen = new Set<string>();
  const highlights = lead.highlights
    .filter((h) => !seen.has(h.rootCause) && seen.add(h.rootCause))
    .slice(0, TEASER_HIGHLIGHTS);
  if (highlights.length < TEASER_HIGHLIGHTS && !lead.teaserReady) {
    throw new TeaserError(
      `only ${highlights.length} confirmed problem(s) with different causes; a teaser is never padded`,
    );
  }

  const n = highlights.length;
  const numberWord = ['no', 'one', 'two', 'three'][n] ?? String(n);
  const things = n === 1 ? 'thing' : 'things';
  const subject = `${lead.company} website: ${numberWord} ${things} we noticed`;
  const pages = `${lead.pagesScanned} public page${lead.pagesScanned === 1 ? '' : 's'}`;
  const checked = dateOnly(lead.checkedAt);

  const md: string[] = [
    `# ${subject}`,
    '',
    `${checked} · Based on ${pages} of ${lead.domain}. No login, no forms submitted.`,
    '',
  ];
  highlights.forEach((h, i) => {
    md.push(`## ${i + 1}. ${h.fact}.`, '');
    md.push(...whereLines(h).flatMap((line) => [line, '']));
    if (h.evidence.screenshot) md.push(`![Screenshot: ${shortLabel(h)}](${h.evidence.screenshot})`, '');
    md.push(`**Why it matters:** ${whyItMatters(h)}`, '');
  });
  md.push('---', '');
  const call = `There is more in the full audit. Happy to walk you through it in ${config.callMinutes} minutes`;
  md.push(config.calendarUrl ? `${call}: <${config.calendarUrl}>` : `${call}.`, '');
  md.push(
    `<p class="method">How we looked: ${config.agency} loaded ${pages} of ${lead.domain} in a browser, as a visitor would${lead.scannedAt ? `, on ${dateOnly(lead.scannedAt)}` : ''}. Each point above was checked again on ${checked}.</p>`,
    '',
  );

  const list = highlights.map((h) => shortLabel(h));
  const listText = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : (list[0] ?? '');
  const email = [
    `Subject: ${subject}`,
    '',
    'Hi {first name},',
    '',
    `We looked at ${pages} of ${lead.domain} and noticed ${numberWord} ${things} you may want to see: ${listText}. The one-page summary is attached; every point has an address you can open to check it.`,
    '',
    config.calendarUrl
      ? `There is more in the full audit. If it is useful, I can walk you through it in ${config.callMinutes} minutes: ${config.calendarUrl}`
      : `There is more in the full audit. If it is useful, I can walk you through it in ${config.callMinutes} minutes.`,
    '',
    config.optOut,
    ...(config.sender ? ['', config.sender, config.agency] : ['', config.agency]),
    '',
  ].join('\n');

  const markdown = md.join('\n');
  for (const [name, text] of [
    ['teaser', markdown],
    ['email', email],
  ] as const) {
    if (hasCausalWording(text))
      throw new TeaserError(`the ${name} text claims a cause, which the pipeline cannot verify`);
  }
  return { highlights, markdown, email, subject };
}

/** Print stylesheet of the one-page teaser (FocusReactive palette on white, for print and email). */
export const TEASER_CSS = `
* { box-sizing: border-box; }
body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #14181d; font-size: 10.5pt; line-height: 1.45; margin: 0; }
h1 { font-size: 18pt; line-height: 1.2; margin: 0 0 4pt; letter-spacing: -0.01em; }
h1 + p { color: #5b6470; font-size: 9pt; margin: 0 0 14pt; padding-bottom: 10pt; border-bottom: 2pt solid #00c25e; }
h2 { font-size: 11.5pt; line-height: 1.3; margin: 12pt 0 4pt; }
p { margin: 0 0 3pt; overflow-wrap: anywhere; }
a { color: #0b6bcb; text-decoration: none; }
strong { font-weight: 600; }
img { display: block; max-width: 100%; max-height: 120pt; margin: 5pt 0; border: 1pt solid #d5dae0; border-radius: 3pt; }
hr { border: 0; border-top: 1pt solid #d5dae0; margin: 12pt 0 8pt; }
.method { color: #5b6470; font-size: 8pt; margin-top: 8pt; }
`;
