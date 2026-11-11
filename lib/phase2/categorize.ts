/**
 * Map an issue message to one of the report's main sections.
 *
 * Heuristic only — uses keyword matching. The taxonomy intentionally mirrors
 * the sections in the human-PDF examples (Performance / SEO / Privacy /
 * Accessibility / UX / Technical) so the synthesis output can mechanically
 * route findings without an LLM.
 */
export type Section = 'performance' | 'seo' | 'privacy' | 'accessibility' | 'ux' | 'technical';

/**
 * Patterns that must win over the general RULES list below. The general rules
 * are matched in order, and Performance's broad `/JavaScript/` claim would
 * otherwise eat error-related findings like "Critical JavaScript errors
 * detected" — which read as Technical, not Performance.
 */
const PRECEDENCE: Array<{ section: Section; patterns: RegExp[] }> = [
  {
    section: 'technical',
    patterns: [
      /\b(console|JS|JavaScript)\s*errors?\b/i,
      /\bcritical\s+(JavaScript|JS|error)/i,
      /uncaught\s+(exception|error)/i,
      /runtime\s+error/i,
      /\bunhandled\s+(promise\s+)?rejection/i,
    ],
  },
];

const RULES: Array<{ section: Section; patterns: RegExp[] }> = [
  {
    section: 'performance',
    patterns: [
      /\b(LCP|CLS|INP|FCP|TTFB|TBT|TTI)\b/i,
      /core web vitals/i,
      /image|images\b/i,
      /\bsrcset\b/i,
      /font|woff|font-display/i,
      /\bCSS\b/i,
      /\bJS\b|JavaScript/i,
      /\bcach(e|ing)/i,
      /render-?blocking/i,
      /preload|preconnect|prefetch/i,
      /\bbundle\b|payload|too many requests/i,
      /coverage|unused/i,
      /critical CSS/i,
      /resource hints?/i,
      /third-party scripts?/i,
      /compression|gzip|brotli/i,
      /HTTP\/[12]/i,
    ],
  },
  {
    section: 'seo',
    patterns: [
      /meta tag|meta description|meta title/i,
      /\btitles?\b/i,
      /\bdescriptions?\b/i,
      /heading|H[1-6]\b/i,
      /sitemap/i,
      /canonical/i,
      /robots\.txt|robots tag/i,
      /schema|structured data|JSON-LD/i,
      /hreflang|alternate/i,
      /URL (?:structure|architecture|depth)/i,
      /trailing slash/i,
      /redirect/i,
      /soft 404|status code|broken links?|404|500/i,
      /internal link|anchor text|PageRank|orphan/i,
      /open graph|og:|twitter:card/i,
      /pagination|rel=["']?next/i,
      /AI (?:bot|crawler)|llms\.txt|AEO/i,
      /freshness|lastmod/i,
      /thin content|insufficient content/i,
      /\bYMYL\b|author attribution|author information|E-E-A-T|EEAT|trust signals?|expertise/i,
      /crawl budget/i,
    ],
  },
  {
    section: 'privacy',
    patterns: [/cookie/i, /consent/i, /privacy|GDPR|CCPA/i, /tracking/i],
  },
  {
    section: 'accessibility',
    patterns: [
      /accessibility|a11y/i,
      /\bWCAG\b/i,
      /\bARIA\b/i,
      /\balt\b|alt text|alt attribute/i,
      /color contrast/i,
      /focus state|focusable/i,
      /form label|label for/i,
      /missing labels|form inputs.*label|inputs?.*missing.*label/i,
      /screen reader|assistive/i,
      /keyboard nav/i,
      /landmark|semantic/i,
      /tabindex/i,
      /touch target/i,
    ],
  },
  {
    section: 'ux',
    patterns: [
      /responsive|viewport/i,
      /mobile-friendly|mobile friendly/i,
      /\bCTA\b/i,
      /\bform\b(?! label)/i, // forms but not form-label (handled by a11y)
    ],
  },
  {
    section: 'technical',
    patterns: [
      /security header|CSP|Content-Security-Policy|X-Frame|X-XSS|HSTS|Permissions-Policy/i,
      /HTTPS|TLS|SSL|certificate/i,
      /mixed content/i,
      /console error/i,
      /DOM (?:depth|nodes|complexity)/i,
      /iframe/i,
      /CMS|DOCTYPE|charset/i,
      /CDN|hosting|DNS|IPv6/i,
      /SRI|subresource integrity/i,
      /open redirect/i,
    ],
  },
];

/** Issue messages raised by the `--visual` analyzers (broken media, text integrity). */
export const VISUAL_FINDING_MESSAGES = [
  'Broken images detected',
  'Failed image or media requests',
  'Unrendered template tokens in page text',
  'Placeholder text (lorem ipsum) on page',
  'Garbled characters (mojibake) in page text',
  'Text clipped by its container',
] as const;

const VISUAL_FINDING_SET: ReadonlySet<string> = new Set(VISUAL_FINDING_MESSAGES.map((m) => m.toLowerCase()));

/** True for a finding raised by the `--visual` analyzers. Tolerates HTML tags and casing. */
export function isVisualFinding(message: string): boolean {
  return VISUAL_FINDING_SET.has(message.replace(/<[^>]*>/g, '').trim().toLowerCase());
}

export function categorize(message: string): Section {
  // Visual findings say "image", so they must win over the Performance image rule.
  if (isVisualFinding(message)) return 'ux';
  // Strip embedded URLs first so a cited example URL ("… — https://site/page")
  // can't trip keyword rules via its scheme/host (e.g. `/HTTPS|TLS|SSL/` matching
  // the `https://` of the link rather than the finding's actual subject).
  const text = message.replace(/https?:\/\/\S+/gi, ' ');
  for (const rule of PRECEDENCE) {
    if (rule.patterns.some((re) => re.test(text))) return rule.section;
  }
  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(text))) return rule.section;
  }
  return 'technical'; // default catch-all
}
