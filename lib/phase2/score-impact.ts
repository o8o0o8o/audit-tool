/**
 * Score-impact estimation for the curated report.
 *
 * Turns the five measured category scores (from the scoring layer) into a
 * "clear path to improve the scores": each category section header shows
 * `current → projected if addressed`, and each finding is annotated with the
 * rough number of points fixing it would recover in its category.
 *
 * Why a dedicated classifier here instead of reusing `classifyIssue` from the
 * scoring catalog: that catalog's *category* field is unreliable for newer /
 * uncatalogued findings — it routes "Missing Permissions-Policy header" to SEO
 * and "Third-party cookies without consent" to Performance via a severity-only
 * fallback. Attributing a security header to the SEO score would be actively
 * misleading in a client deliverable, so we keep an explicit keyword map for
 * the *scored* categories and own its correctness.
 *
 * The projection is an estimate, not a guarantee: only SEO and Technical are
 * literal functions of the findings (URL-pass ratio over error-tier issues);
 * Performance, Accessibility and Security are computed from continuous per-page
 * metrics (CWV / axe / Observatory), so "fix this finding → +N pts" is a
 * reasoned approximation of resolving the *class* of problem it represents. The
 * report labels every number with `~` and explains the method in Methodology.
 */

/** The five categories the scoring layer actually produces a 0–100 score for. */
export type ScoredCategory = 'seo' | 'performance' | 'accessibility' | 'security' | 'technical';

export interface CategoryStatus {
  current: number;
  /** Score we'd expect once the section's issues are addressed (estimate). */
  projected: number;
  /** projected − current, rounded. 0 when the category is already at ceiling. */
  gain: number;
}

export interface ScoreImpact {
  /** Per-category current/projected, only for categories with a finite score. */
  categories: Partial<Record<ScoredCategory, CategoryStatus>>;
  /** message → { category, points } — only findings worth ≥1 point. */
  findingLift: Map<string, { category: ScoredCategory; points: number }>;
}

const LABELS: Record<ScoredCategory, string> = {
  seo: 'SEO',
  performance: 'Performance',
  accessibility: 'Accessibility',
  security: 'Security',
  technical: 'Technical',
};

export function categoryLabel(c: ScoredCategory): string {
  return LABELS[c];
}

// ─── Reliable scored-category classifier ─────────────────────────────────────

/**
 * Ordered keyword rules. First match wins. Order matters:
 *   1. Technical *errors* — before the broad Performance `JavaScript` rule, so
 *      "Critical JavaScript errors" reads as Technical, not Performance.
 *   2. Security — before everything else so headers / SRI / cookies land on the
 *      Security score even though the legacy catalog misroutes them.
 *   3. Accessibility, 4. Performance, 5. SEO, 6. Technical (default).
 */
const RULES: Array<{ category: ScoredCategory; patterns: RegExp[] }> = [
  {
    category: 'technical',
    patterns: [
      /\b(console|JS|JavaScript)\s+errors?\b/i,
      /\bcritical\s+(JavaScript|JS|error)/i,
      /uncaught\s+(exception|error)/i,
      /runtime\s+error/i,
      /unhandled\s+(promise\s+)?rejection/i,
    ],
  },
  {
    category: 'security',
    patterns: [
      /security header|Content-Security-Policy|\bCSP\b|X-Frame|X-XSS|X-Content-Type/i,
      /\bHSTS\b|Strict-Transport|Permissions-Policy|Referrer-Policy/i,
      /cross-origin (isolation|opener|embedder)|\bCOOP\b|\bCOEP\b/i,
      /Subresource Integrity|\bSRI\b/i,
      /mixed content/i,
      /\bHTTPS\b|\bTLS\b|\bSSL\b|certificate/i,
      /source maps? (exposed|in production)/i,
      /cookie/i,
      /consent/i,
      /tracking/i,
      /privacy|GDPR|CCPA/i,
    ],
  },
  {
    category: 'accessibility',
    patterns: [
      /accessibility|a11y/i,
      /\bWCAG\b/i,
      /\bARIA\b/i,
      /\balt\b|alt text|alt attribute/i,
      /color contrast/i,
      /focus state|focusable|focus order/i,
      /\blabels?\b|label for|for\/id/i,
      /form inputs?.*(label|autocomplete)/i,
      /screen reader|assistive/i,
      /keyboard|tabindex/i,
      /landmark|semantic HTML|<main>|<article>|<section>/i,
      /touch target/i,
      /captions?|transcripts?/i,
      /prefers-reduced-motion/i,
      /fieldset/i,
      /\blang attribute\b/i,
    ],
  },
  {
    category: 'performance',
    patterns: [
      /\b(LCP|CLS|INP|FCP|TTFB|TBT|TTI)\b/i,
      /core web vitals/i,
      /\bimages?\b|\bsrcset\b/i,
      /font|woff|font-display/i,
      /\bCSS\b/i,
      /\bJS\b|JavaScript/i,
      /cach(e|ing)/i,
      /render-?blocking/i,
      /preload|preconnect|prefetch|resource hints?/i,
      /bundle|payload|too many requests/i,
      /coverage|unused/i,
      /third-party (scripts?|payload|origins?|requests?|connections?)/i,
      /advertising scripts?/i,
      /compression|gzip|brotli/i,
      /page.*size is too big|excessive total image size/i,
    ],
  },
  {
    category: 'seo',
    patterns: [
      /meta tag|meta description|meta title/i,
      /\btitles?\b|\bdescriptions?\b/i,
      /heading|\bh[1-6]\b/i,
      /sitemap/i,
      /canonical/i,
      /robots\.txt|robots tag|X-Robots/i,
      /schema|structured data|JSON-LD|FAQPage|Article|Organization|Person missing/i,
      /hreflang|alternate/i,
      /\bURL\b|trailing slash/i,
      /redirect/i,
      /soft 404|status code|broken (links?|outbound)|\b404\b|\b500\b/i,
      /internal link|anchor text|PageRank|orphan|link equity|crawl budget|pagination/i,
      /open graph|og:|twitter:?card|social media tags?/i,
      /AI (?:bot|crawler)|llms\.txt|AEO/i,
      /freshness|lastmod|author|byline|YMYL|E-E-A-T/i,
      /thin content|low content|word count|text-to-HTML|duplicate|near-duplicate|similar content|keyword|topic/i,
      /indexab|noindex/i,
    ],
  },
];

export function scoredCategoryOf(message: string): ScoredCategory {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(message))) return rule.category;
  }
  return 'technical';
}

// ─── Weighting ────────────────────────────────────────────────────────────────

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 1.0,
  high: 0.6,
  medium: 0.3,
  low: 0.12,
};

/** Severities we expect a team to actually resolve — drive the projection. */
const RECOVERABLE = new Set(['critical', 'high', 'medium']);

function severityWeight(severity: string | undefined): number {
  return SEVERITY_WEIGHT[(severity ?? 'medium').toLowerCase()] ?? 0.2;
}

/** Broad issues weigh more, with diminishing returns (1× … 2×). */
function breadthFactor(count: number): number {
  return 1 + Math.min(1, Math.log2(1 + Math.max(0, count)) / 6);
}

function findingWeight(severity: string | undefined, count: number): number {
  return severityWeight(severity) * breadthFactor(count || 1);
}

interface FindingLike {
  severity?: string;
  count?: number;
}

/**
 * Build the score-impact model from the measured category scores and the
 * report's working finding set.
 *
 * For each category with a finite score < 100:
 *   gap          = 100 − current
 *   denom        = Σ weight over ALL findings in the category (every severity)
 *   liftₓ        = gap · weightₓ / denom            (per finding)
 *   projected    = current + Σ liftₓ over recoverable (critical/high/medium)
 *
 * Leaving the low-severity long tail in the denominator but out of the
 * projected sum keeps `projected` below 100 — honest about residual debt you
 * won't realistically clear. Per-finding `liftₓ` and the projected gain stay
 * internally consistent (they share one denominator).
 */
export function buildScoreImpact(
  categoryScores: Record<string, number> | undefined,
  details: Record<string, FindingLike>,
): ScoreImpact {
  const out: ScoreImpact = { categories: {}, findingLift: new Map() };
  if (!categoryScores) return out;

  // Group findings by scored category, retaining per-finding weight.
  const grouped = new Map<ScoredCategory, Array<{ message: string; severity?: string; weight: number }>>();
  for (const [message, detail] of Object.entries(details)) {
    const cat = scoredCategoryOf(message);
    const weight = findingWeight(detail.severity, detail.count ?? 1);
    const list = grouped.get(cat) ?? [];
    list.push({ message, severity: detail.severity, weight });
    grouped.set(cat, list);
  }

  for (const [cat, findings] of grouped) {
    const current = categoryScores[cat];
    if (typeof current !== 'number' || !Number.isFinite(current)) continue;
    const gap = Math.max(0, 100 - current);
    const denom = findings.reduce((s, f) => s + f.weight, 0);
    if (gap <= 0 || denom <= 0) {
      // Already at ceiling (or no weighted findings): record status, no lift.
      out.categories[cat] = { current: Math.round(current), projected: Math.round(current), gain: 0 };
      continue;
    }

    let recoveredGain = 0;
    for (const f of findings) {
      const liftRaw = (gap * f.weight) / denom;
      if (RECOVERABLE.has((f.severity ?? 'medium').toLowerCase())) recoveredGain += liftRaw;
      const points = Math.round(liftRaw);
      if (points >= 1) out.findingLift.set(f.message, { category: cat, points });
    }
    const projected = Math.min(99, Math.round(current + recoveredGain));
    out.categories[cat] = {
      current: Math.round(current),
      projected,
      gain: Math.max(0, projected - Math.round(current)),
    };
  }

  return out;
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

/**
 * The ` — Security 44/100 → ~58 · Technical 100/100` suffix for a section
 * header, built from the distinct scored categories present in that section.
 * Categories are ordered by improvement headroom (biggest gain first) so the
 * actionable score leads. Returns '' when no category has a known score.
 */
export function sectionScoreSuffix(categories: ScoredCategory[], impact: ScoreImpact): string {
  const seen = new Set<ScoredCategory>();
  const entries: CategoryStatus[] = [];
  const ordered: Array<{ cat: ScoredCategory; status: CategoryStatus }> = [];
  for (const cat of categories) {
    if (seen.has(cat)) continue;
    seen.add(cat);
    const status = impact.categories[cat];
    if (!status) continue;
    ordered.push({ cat, status });
    entries.push(status);
  }
  if (ordered.length === 0) return '';
  ordered.sort((a, b) => b.status.gain - a.status.gain || a.status.current - b.status.current);

  const parts = ordered.map(({ cat, status }) => {
    const base = `${categoryLabel(cat)} ${status.current}/100`;
    return status.gain >= 1 ? `${base} → ~${status.projected}` : base;
  });
  return `  —  ${parts.join(' · ')}`;
}

/** Inline header chip for a single finding, e.g. `+~8 pts to Security`. */
export function findingLiftChip(message: string, impact: ScoreImpact): string | null {
  const lift = impact.findingLift.get(message);
  if (!lift) return null;
  return `+~${lift.points} ${lift.points === 1 ? 'pt' : 'pts'} to ${categoryLabel(lift.category)}`;
}
