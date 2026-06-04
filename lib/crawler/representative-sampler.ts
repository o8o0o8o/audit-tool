/**
 * RepresentativeSampler
 *
 * Decides which URLs deserve expensive evidence capture (screenshots, HAR).
 * The goal is to cover the visual / behavioural variety of a site without
 * capturing every URL.
 *
 * Strategy (v1):
 *   • Always sample the homepage (origin URL).
 *   • Bucket URLs by template:
 *       /                  → "/"
 *       /about             → "/about"
 *       /blog              → "/blog"          (listing page is its own bucket)
 *       /blog/post-1       → "/blog/*"        (children grouped)
 *       /blog/2025/foo     → "/blog/*"        (deeper still grouped)
 *   • Capture the first URL we see per bucket.
 *   • Cap total samples at `cap` (default 10).
 *
 * Trailing slashes, query strings, and fragments are ignored when bucketing.
 */

export class RepresentativeSampler {
  readonly #cap: number;
  readonly #seenBuckets = new Set<string>();
  readonly #sampled: string[] = [];

  constructor(cap = 10) {
    this.#cap = Math.max(1, cap);
  }

  /**
   * Returns true exactly once per bucket, up to `cap` total samples.
   * The caller should treat a `true` return as authorization to capture
   * evidence for this URL.
   */
  shouldSample(url: string): boolean {
    if (this.#sampled.length >= this.#cap) return false;

    const bucket = RepresentativeSampler.bucketOf(url);
    if (bucket === null) return false; // unparseable URL
    if (this.#seenBuckets.has(bucket)) return false;

    this.#seenBuckets.add(bucket);
    this.#sampled.push(url);
    return true;
  }

  /**
   * Non-consuming peek: would `shouldSample(url)` return true right now?
   * Used to decide cheap, early captures (e.g. the first-load screenshot taken
   * during navigation) before the authoritative `shouldSample` call later in
   * the page pipeline. Under concurrency two pages in the same bucket may both
   * peek true — harmless, only one wins the later `shouldSample`.
   */
  wouldSample(url: string): boolean {
    if (this.#sampled.length >= this.#cap) return false;
    const bucket = RepresentativeSampler.bucketOf(url);
    if (bucket === null) return false;
    return !this.#seenBuckets.has(bucket);
  }

  /** URLs that have already been sampled, in insertion order. */
  getSampledUrls(): string[] {
    return [...this.#sampled];
  }

  /** Buckets that have already been seen. Useful for diagnostics. */
  getSeenBuckets(): string[] {
    return [...this.#seenBuckets];
  }

  /**
   * Compute the bucket key for a URL.
   * Returns null when the URL can't be parsed.
   */
  static bucketOf(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return '/';
    if (segments.length === 1) return `/${segments[0]}`;
    return `/${segments[0]}/*`;
  }
}
