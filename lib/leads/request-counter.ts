/**
 * Counts the requests a lead scan sends to the prospect's own hosts, so the load we put on a site
 * is a measured number and not a guess. Two channels:
 *
 *  - `browser`: requests from the crawl's browser contexts (page loads and their assets),
 *  - `node`: requests made from Node with `fetch` (robots.txt, sitemaps, text files, probes).
 *
 * Requests to other hosts (Google APIs, third-party scripts, DNS) are not counted: they do not
 * reach the prospect. DNS lookups are not HTTP requests and are not counted either.
 */

export interface RequestCounts {
  browser: number;
  node: number;
  total: number;
}

export class RequestCounter {
  readonly #site: string;
  #browser = 0;
  #node = 0;
  #restoreFetch: (() => void) | null = null;

  /** `siteDomain`: the prospect's domain without `www.`; subdomains count as the same site. */
  constructor(siteDomain: string) {
    this.#site = siteDomain.toLowerCase().replace(/^www\./, '');
  }

  isSiteUrl(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      return host === this.#site || host.endsWith(`.${this.#site}`);
    } catch {
      return false;
    }
  }

  /** Observer for browser requests (`context.on('request')`). */
  readonly observeBrowser = (url: string): void => {
    if (this.isSiteUrl(url)) this.#browser++;
  };

  /** Wraps the global `fetch` so every Node-side request to the site is counted. Idempotent. */
  installFetch(): void {
    if (this.#restoreFetch) return;
    const original = globalThis.fetch;
    const wrapped = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (this.isSiteUrl(url)) this.#node++;
      return original(input, init);
    }) as typeof fetch;
    globalThis.fetch = wrapped;
    this.#restoreFetch = () => {
      if (globalThis.fetch === wrapped) globalThis.fetch = original;
    };
  }

  uninstallFetch(): void {
    this.#restoreFetch?.();
    this.#restoreFetch = null;
  }

  get counts(): RequestCounts {
    return { browser: this.#browser, node: this.#node, total: this.#browser + this.#node };
  }
}
