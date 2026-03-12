/**
 * Technology Detector
 * Detects CMS, frameworks, analytics, CDNs, and other technologies used on a page
 * Similar to Wappalyzer/BuiltWith
 */

import type { ChromePage, ParsedPage } from '../../types';

class TechnologyDetector {
  // Technology signatures organized by category
  static SIGNATURES = {
    // Content Management Systems
    cms: [
      {
        name: 'WordPress',
        patterns: {
          html: [/wp-content/i, /wp-includes/i],
          meta: { generator: /wordpress/i },
          scripts: [/wp-content|wp-includes/i],
        },
      },
      {
        name: 'Drupal',
        patterns: {
          html: [/Drupal\.settings/i, /drupal\.js/i],
          meta: { generator: /drupal/i },
          headers: { 'x-drupal-cache': /./i },
        },
      },
      { name: 'Joomla', patterns: { html: [/\/media\/jui\//i], meta: { generator: /joomla/i } } },
      {
        name: 'Shopify',
        patterns: {
          html: [/cdn\.shopify\.com/i, /Shopify\.theme/i],
          scripts: [/cdn\.shopify\.com/i],
          cookies: [/^_shopify/i],
        },
      },
      {
        name: 'Squarespace',
        patterns: { html: [/squarespace\.com/i, /static\.squarespace/i], scripts: [/squarespace/i] },
      },
      { name: 'Wix', patterns: { html: [/wix\.com/i, /wixstatic\.com/i], meta: { generator: /wix/i } } },
      { name: 'Webflow', patterns: { html: [/webflow/i], meta: { generator: /webflow/i }, scripts: [/webflow/i] } },
      { name: 'Ghost', patterns: { meta: { generator: /ghost/i }, html: [/ghost\.org/i] } },
      { name: 'Contentful', patterns: { scripts: [/contentful\.com|\/contentful\./i] } },
      { name: 'Sanity', patterns: { scripts: [/sanity\.io|cdn\.sanity\.io/i] } },
      { name: 'Strapi', patterns: { scripts: [/\/strapi\//i] } },
      { name: 'HubSpot CMS', patterns: { html: [/hs-scripts\.com/i, /hubspot/i], scripts: [/hubspot/i] } },
      { name: 'BigCommerce', patterns: { html: [/bigcommerce/i], scripts: [/bigcommerce/i] } },
      { name: 'Magento', patterns: { html: [/mage\/cookies/i, /Magento_/i], cookies: [/^PHPSESSID/i, /^frontend/i] } },
      { name: 'PrestaShop', patterns: { html: [/prestashop/i], meta: { generator: /prestashop/i } } },
    ],

    // JavaScript Frameworks
    frameworks: [
      {
        name: 'React',
        patterns: {
          html: [/data-reactroot|data-reactid|__react/i],
          scripts: [/react\.production|react\.development|react-dom/i],
          globals: ['React', '__REACT_DEVTOOLS_GLOBAL_HOOK__'],
        },
      },
      {
        name: 'Next.js',
        patterns: {
          html: [/__NEXT_DATA__|_next\/static|_next\/image/],
          scripts: [/_next\/static\//],
          globals: ['__NEXT_DATA__'],
        },
      },
      {
        name: 'Vue.js',
        patterns: {
          html: [/data-v-[a-f0-9]{6,}/i, /v-cloak/i],
          scripts: [/\/vue\.js|\/vue\.min\.js|\/vue\.runtime|\/vue@/i],
          globals: ['Vue', '__VUE__'],
        },
      },
      { name: 'Nuxt.js', patterns: { html: [/__NUXT__/], scripts: [/_nuxt\//], globals: ['__NUXT__'] } },
      {
        name: 'Angular',
        patterns: {
          html: [/ng-version="/, /_ngcontent-/, /_nghost-/],
          scripts: [/\/@angular\//i, /\/angular\.min\.js/i],
        },
      },
      {
        name: 'Svelte',
        patterns: { html: [/svelte-[a-z0-9]+|__svelte/], scripts: [/\/svelte\//i, /svelte\.min\.js/i] },
      },
      { name: 'SvelteKit', patterns: { html: [/__sveltekit/], scripts: [/sveltekit/i] } },
      { name: 'Gatsby', patterns: { html: [/id="___gatsby"|___gatsby/], scripts: [/\/gatsby-/i] } },
      { name: 'Remix', patterns: { html: [/__remixContext/], globals: ['__remixContext'] } },
      { name: 'Astro', patterns: { html: [/astro-island|data-astro/], scripts: [/astro\/[a-z]/i] } },
      { name: 'jQuery', patterns: { scripts: [/\/jquery[\.-]\d|\/jquery\.min\.js/i], globals: ['jQuery'] } },
      { name: 'Alpine.js', patterns: { html: [/x-data\s*=|x-init\s*=/i], scripts: [/\/alpine[\.\/@]/i] } },
      { name: 'HTMX', patterns: { html: [/hx-get\s*=|hx-post\s*=|hx-trigger\s*=/i], scripts: [/\/htmx[\.\/@]/i] } },
      {
        name: 'Ember.js',
        patterns: {
          html: [/data-ember-action|id="ember\d+"|class="ember-view"/],
          scripts: [/\/ember\.js|\/ember\.min\.js|\/ember\.prod/i],
          globals: ['Ember'],
        },
      },
      { name: 'Backbone.js', patterns: { scripts: [/\/backbone[\.\-]|\/backbone\.min\.js/i], globals: ['Backbone'] } },
    ],

    // CSS Frameworks
    cssFrameworks: [
      {
        name: 'Tailwind CSS',
        patterns: {
          html: [
            /class="[^"]*(?:sm:|md:|lg:|xl:)[^"]*"/i,
            /class="[^"]*(?:p-\d|m-\d|text-\w+-\d{3}|bg-\w+-\d{3})[^"]*"/i,
          ],
        },
      },
      {
        name: 'Bootstrap',
        patterns: {
          html: [
            /class="[^"]*(?:col-(?:sm|md|lg|xl)-\d|navbar-(?:brand|toggler)|btn-(?:primary|secondary|success|danger))[^"]*"/i,
          ],
          scripts: [/\/bootstrap[\.\-]|\/bootstrap\.min/i],
        },
      },
      {
        name: 'Material UI',
        patterns: { html: [/class="[^"]*Mui[A-Z][a-z]+-root[^"]*"/], scripts: [/\/@mui\//i, /\/material-ui\//i] },
      },
      { name: 'Chakra UI', patterns: { html: [/class="[^"]*chakra-[a-z]/i], scripts: [/\/@chakra-ui\//i] } },
      {
        name: 'Bulma',
        patterns: {
          html: [/class="[^"]*(?:is-size-\d|is-(?:primary|success|warning|danger|info)|has-text-|column is-)[^"]*"/i],
          scripts: [/\/bulma[\.\/@]/i],
        },
      },
      {
        name: 'Foundation',
        patterns: {
          html: [/class="[^"]*(?:grid-x|grid-y|cell (?:small|medium|large)-\d)[^"]*"/i],
          scripts: [/\/foundation[\.\-]/i],
        },
      },
    ],

    // Analytics & Tracking
    analytics: [
      {
        name: 'Google Analytics 4',
        patterns: { html: [/gtag\(['"]/i, /G-[A-Z0-9]+/i], scripts: [/googletagmanager\.com\/gtag/i] },
      },
      {
        name: 'Google Universal Analytics',
        patterns: { html: [/UA-\d+-\d+/i], scripts: [/google-analytics\.com\/analytics/i] },
      },
      { name: 'Google Tag Manager', patterns: { html: [/GTM-[A-Z0-9]+/i], scripts: [/googletagmanager\.com\/gtm/i] } },
      {
        name: 'Facebook Pixel',
        patterns: { html: [/fbq\(/i, /connect\.facebook\.net\/.*fbevents/i], scripts: [/connect\.facebook\.net/i] },
      },
      { name: 'Hotjar', patterns: { html: [/hotjar/i], scripts: [/hotjar\.com|static\.hotjar/i] } },
      { name: 'Mixpanel', patterns: { scripts: [/mixpanel/i], globals: ['mixpanel'] } },
      { name: 'Amplitude', patterns: { scripts: [/amplitude/i], globals: ['amplitude'] } },
      { name: 'Segment', patterns: { scripts: [/segment\.com|segment\.io/i], globals: ['analytics'] } },
      { name: 'Heap', patterns: { scripts: [/heap\.io|heapanalytics/i], globals: ['heap'] } },
      { name: 'Plausible', patterns: { scripts: [/plausible\.io/i] } },
      { name: 'Fathom', patterns: { scripts: [/usefathom\.com/i] } },
      { name: 'Matomo', patterns: { scripts: [/matomo|piwik/i] } },
      { name: 'Adobe Analytics', patterns: { scripts: [/omtrdc\.net|adobedtm\.com/i] } },
      { name: 'Clarity', patterns: { scripts: [/clarity\.ms/i] } },
      { name: 'FullStory', patterns: { scripts: [/fullstory/i], globals: ['FS'] } },
      { name: 'LogRocket', patterns: { scripts: [/logrocket/i], globals: ['LogRocket'] } },
      { name: 'PostHog', patterns: { scripts: [/posthog/i], globals: ['posthog'] } },
    ],

    // Marketing & CRM
    marketing: [
      { name: 'HubSpot', patterns: { scripts: [/js\.hs-scripts\.com|hubspot/i] } },
      { name: 'Mailchimp', patterns: { html: [/mailchimp/i], scripts: [/mailchimp|chimpstatic/i] } },
      { name: 'Intercom', patterns: { scripts: [/widget\.intercom\.io|intercomcdn/i], globals: ['Intercom'] } },
      { name: 'Drift', patterns: { scripts: [/js\.driftt\.com|drift\.com\/include/i], globals: ['drift'] } },
      { name: 'Zendesk', patterns: { scripts: [/static\.zdassets\.com|zopim/i], globals: ['zE'] } },
      { name: 'Crisp', patterns: { scripts: [/crisp\.chat/i], globals: ['$crisp'] } },
      { name: 'Tawk.to', patterns: { scripts: [/tawk\.to/i], globals: ['Tawk_API'] } },
      { name: 'LiveChat', patterns: { scripts: [/livechat/i], globals: ['LiveChatWidget'] } },
      { name: 'Klaviyo', patterns: { scripts: [/klaviyo/i] } },
      { name: 'Braze', patterns: { scripts: [/braze/i] } },
      { name: 'Optimizely', patterns: { scripts: [/optimizely/i] } },
      { name: 'VWO', patterns: { scripts: [/visualwebsiteoptimizer/i] } },
      { name: 'Google Optimize', patterns: { scripts: [/googleoptimize/i] } },
    ],

    // CDN & Hosting
    cdn: [
      { name: 'Cloudflare', patterns: { headers: { server: /cloudflare/i, 'cf-ray': /./i } } },
      { name: 'Fastly', patterns: { headers: { 'x-served-by': /cache/i, via: /varnish/i } } },
      { name: 'AWS CloudFront', patterns: { headers: { 'x-amz-cf-id': /./i, via: /cloudfront/i } } },
      { name: 'Akamai', patterns: { headers: { 'x-akamai': /./i, server: /akamai/i } } },
      { name: 'Vercel', patterns: { headers: { 'x-vercel-id': /./i, server: /vercel/i } } },
      { name: 'Netlify', patterns: { headers: { 'x-nf-request-id': /./i, server: /netlify/i } } },
      { name: 'GitHub Pages', patterns: { headers: { server: /github/i } } },
      { name: 'Render', patterns: { headers: { 'x-render-origin-server': /./i } } },
      { name: 'Railway', patterns: { headers: { 'x-railway': /./i } } },
      { name: 'Heroku', patterns: { headers: { via: /heroku/i } } },
      { name: 'DigitalOcean', patterns: { headers: { server: /digitalocean/i } } },
      { name: 'Bunny CDN', patterns: { headers: { server: /bunny/i } } },
      { name: 'KeyCDN', patterns: { headers: { server: /keycdn/i } } },
      { name: 'jsDelivr', patterns: { scripts: [/jsdelivr\.net/i] } },
      { name: 'unpkg', patterns: { scripts: [/unpkg\.com/i] } },
      { name: 'cdnjs', patterns: { scripts: [/cdnjs\.cloudflare\.com/i] } },
    ],

    // E-commerce
    ecommerce: [
      { name: 'Stripe', patterns: { scripts: [/js\.stripe\.com/i], globals: ['Stripe'] } },
      { name: 'PayPal', patterns: { scripts: [/paypal\.com/i], globals: ['paypal'] } },
      { name: 'Square', patterns: { scripts: [/squareup\.com/i] } },
      { name: 'Klarna', patterns: { scripts: [/klarna/i] } },
      { name: 'Afterpay', patterns: { scripts: [/afterpay/i] } },
      { name: 'Snipcart', patterns: { scripts: [/snipcart/i] } },
      { name: 'Gumroad', patterns: { scripts: [/gumroad/i] } },
      { name: 'Paddle', patterns: { scripts: [/paddle\.js|paddle\.com/i] } },
      { name: 'Shopify Buy Button', patterns: { scripts: [/sdks\.shopifycdn/i] } },
      { name: 'WooCommerce', patterns: { html: [/woocommerce/i], scripts: [/woocommerce/i] } },
    ],

    // Security & Performance
    security: [
      { name: 'reCAPTCHA', patterns: { scripts: [/recaptcha/i], globals: ['grecaptcha'] } },
      { name: 'hCaptcha', patterns: { scripts: [/hcaptcha/i] } },
      { name: 'Cloudflare Turnstile', patterns: { scripts: [/turnstile/i] } },
      { name: 'Sucuri', patterns: { headers: { 'x-sucuri': /./i } } },
      { name: 'Imperva', patterns: { headers: { 'x-iinfo': /./i } } },
    ],

    // Media & Video
    media: [
      { name: 'YouTube Embed', patterns: { html: [/youtube\.com\/embed|youtube-nocookie\.com/i] } },
      { name: 'Vimeo', patterns: { html: [/player\.vimeo\.com/i], scripts: [/vimeo/i] } },
      { name: 'Wistia', patterns: { scripts: [/wistia/i] } },
      { name: 'Vidyard', patterns: { scripts: [/vidyard/i] } },
      { name: 'Cloudinary', patterns: { html: [/cloudinary\.com/i], scripts: [/cloudinary/i] } },
      { name: 'imgix', patterns: { html: [/imgix\.net/i] } },
    ],

    // Fonts
    fonts: [
      { name: 'Google Fonts', patterns: { html: [/fonts\.googleapis\.com|fonts\.gstatic\.com/i] } },
      { name: 'Adobe Fonts', patterns: { html: [/use\.typekit\.net/i] } },
      { name: 'Font Awesome', patterns: { html: [/fontawesome|font-awesome/i], scripts: [/fontawesome/i] } },
    ],

    // SEO & Schema
    seo: [
      { name: 'Yoast SEO', patterns: { html: [/yoast-schema|yoast seo/i] } },
      { name: 'Rank Math', patterns: { html: [/rank-math/i] } },
      { name: 'All in One SEO', patterns: { html: [/all in one seo/i] } },
      { name: 'Schema.org', patterns: { html: [/schema\.org/i, /application\/ld\+json/i] } },
    ],

    // Other
    other: [
      { name: 'PWA', patterns: { html: [/manifest\.json/i], globals: ['serviceWorker'] } },
      { name: 'AMP', patterns: { html: [/<html[^>]*amp/i, /cdn\.ampproject\.org/i] } },
      { name: 'Turbo', patterns: { html: [/data-turbo-/i], scripts: [/\/turbo[\.\/@]/i] } },
      { name: 'Stimulus', patterns: { html: [/data-controller\s*=/i], scripts: [/\/stimulus[\.\/@]/i] } },
      { name: 'Partytown', patterns: { scripts: [/\/partytown\//i] } },
      { name: 'Sentry', patterns: { scripts: [/browser\.sentry-cdn|sentry\.io\/\d/i], globals: ['Sentry'] } },
      { name: 'DataDog', patterns: { scripts: [/datadoghq\.com/i] } },
      { name: 'New Relic', patterns: { scripts: [/nr-data\.net|newrelic\.com/i] } },
      { name: 'LaunchDarkly', patterns: { scripts: [/launchdarkly\.com/i] } },
    ],
  };

  /**
   * Detect technologies on a page
   * @param {Object} chromePage - Playwright page object
   * @param {Object} parsedPage - Parsed HTML (node-html-parser)
   * @param {string} htmlContent - Raw HTML content
   * @param {Object} responseHeaders - HTTP response headers
   * @param {Object} requests - Network requests made by the page
   * @returns {Object} Detection results
   */
  static async detect(
    chromePage: ChromePage,
    parsedPage: ParsedPage,
    htmlContent: string,
    responseHeaders: Record<string, any> = {},
    requests: Record<string, any> = {},
  ) {
    const detected = {
      technologies: [] as Record<string, any>[],
      byCategory: {} as Record<string, string[]>,
      summary: {
        total: 0,
        categories: [] as Record<string, any>[],
      },
    };

    const htmlLower = (htmlContent || '').toLowerCase();
    const headersLower = this.#lowercaseHeaders(responseHeaders);
    const scriptSrcs = this.#extractScriptSources(parsedPage, requests);
    const metaTags = this.#extractMetaTags(parsedPage);

    // Get global variables from browser context
    let globals: string[] = [];
    try {
      const result = await chromePage.evaluate(() => {
        const knownGlobals = [
          'React',
          '__REACT_DEVTOOLS_GLOBAL_HOOK__',
          'Vue',
          '__VUE__',
          'jQuery',
          'Ember',
          'Backbone',
          '__NEXT_DATA__',
          '__NUXT__',
          '__remixContext',
          'mixpanel',
          'amplitude',
          'heap',
          'FS',
          'LogRocket',
          'posthog',
          'Intercom',
          'drift',
          'zE',
          '$crisp',
          'Tawk_API',
          'LiveChatWidget',
          'Stripe',
          'paypal',
          'grecaptcha',
          'Sentry',
        ];
        return knownGlobals.filter((g) => {
          try {
            return typeof (window as any)[g] !== 'undefined';
          } catch {
            return false;
          }
        });
      });
      globals = result as string[];
    } catch {
      // Browser context not available
    }

    // Check each category
    for (const [category, signatures] of Object.entries(this.SIGNATURES)) {
      detected.byCategory[category] = [];

      for (const sig of signatures) {
        const detectionMethods = this.#matchSignature(sig, htmlLower, headersLower, scriptSrcs, metaTags, globals);
        if (detectionMethods) {
          const tech = {
            name: sig.name,
            category: this.#formatCategory(category),
            confidence: this.#calculateConfidence(sig, htmlLower, headersLower, scriptSrcs, metaTags, globals),
            detectedBy: detectionMethods,
          };
          detected.technologies.push(tech);
          detected.byCategory[category].push(sig.name);
        }
      }
    }

    // Calculate summary
    detected.summary.total = detected.technologies.length;
    detected.summary.categories = Object.entries(detected.byCategory)
      .filter(([_, techs]: [string, any]) => techs.length > 0)
      .map(([cat, techs]: [string, any]) => ({
        category: this.#formatCategory(cat),
        count: techs.length,
        technologies: techs,
      }));

    return detected;
  }

  /**
   * Quick detection without browser context (for faster analysis)
   */
  static detectFromHtml(htmlContent: string, responseHeaders: Record<string, any> = {}, scriptSrcs: string[] = []) {
    const detected = {
      technologies: [] as Record<string, any>[],
      byCategory: {} as Record<string, string[]>,
      summary: { total: 0, categories: [] as Record<string, any>[] },
    };

    const htmlLower = (htmlContent || '').toLowerCase();
    const headersLower = this.#lowercaseHeaders(responseHeaders);
    const metaTags = this.#extractMetaTagsFromHtml(htmlContent);

    for (const [category, signatures] of Object.entries(this.SIGNATURES)) {
      detected.byCategory[category] = [];

      for (const sig of signatures) {
        const detectionMethods = this.#matchSignature(sig, htmlLower, headersLower, scriptSrcs, metaTags, []);
        if (detectionMethods) {
          detected.technologies.push({
            name: sig.name,
            category: this.#formatCategory(category),
            confidence: 'medium',
            detectedBy: detectionMethods,
          });
          detected.byCategory[category].push(sig.name);
        }
      }
    }

    detected.summary.total = detected.technologies.length;
    detected.summary.categories = Object.entries(detected.byCategory)
      .filter(([_, techs]: [string, any]) => techs.length > 0)
      .map(([cat, techs]: [string, any]) => ({
        category: this.#formatCategory(cat),
        count: techs.length,
        technologies: techs,
      }));

    return detected;
  }

  /**
   * Match a signature against page data and return detection methods
   * @private
   * @returns {Object|null} Detection methods or null if not matched
   */
  static #matchSignature(
    sig: Record<string, any>,
    htmlLower: string,
    headersLower: Record<string, any>,
    scriptSrcs: string[],
    metaTags: Record<string, string>,
    globals: string[],
  ) {
    const patterns = sig.patterns || {};
    const methods: Record<string, any>[] = [];

    // Check HTML patterns
    if (patterns.html) {
      for (const pattern of patterns.html) {
        if (pattern.test(htmlLower)) {
          methods.push({ type: 'html', pattern: pattern.source });
          break; // One match per type is enough
        }
      }
    }

    // Check script sources
    if (patterns.scripts) {
      for (const pattern of patterns.scripts) {
        for (const src of scriptSrcs) {
          if (pattern.test(src)) {
            methods.push({ type: 'script', pattern: pattern.source, matched: src.substring(0, 60) });
            break;
          }
        }
        if (methods.some((m) => m.type === 'script')) break;
      }
    }

    // Check meta tags
    if (patterns.meta) {
      for (const [name, pattern] of Object.entries(patterns.meta) as [string, RegExp][]) {
        const value = metaTags[name.toLowerCase()];
        if (value && pattern.test(value)) {
          methods.push({ type: 'meta', tag: name, value: value.substring(0, 50) });
          break;
        }
      }
    }

    // Check headers
    if (patterns.headers) {
      for (const [header, pattern] of Object.entries(patterns.headers) as [string, RegExp][]) {
        const value = headersLower[header.toLowerCase()];
        if (value && pattern.test(value)) {
          methods.push({ type: 'header', header: header, value: String(value).substring(0, 50) });
          break;
        }
      }
    }

    // Check cookies
    if (patterns.cookies && headersLower['set-cookie']) {
      const cookies = headersLower['set-cookie'];
      for (const pattern of patterns.cookies) {
        if (pattern.test(cookies)) {
          methods.push({ type: 'cookie', pattern: pattern.source });
          break;
        }
      }
    }

    // Check global variables
    if (patterns.globals && globals.length > 0) {
      for (const global of patterns.globals) {
        if (globals.includes(global)) {
          methods.push({ type: 'global', variable: global });
          break;
        }
      }
    }

    return methods.length > 0 ? methods : null;
  }

  /**
   * Calculate confidence level
   * @private
   */
  static #calculateConfidence(
    sig: Record<string, any>,
    htmlLower: string,
    headersLower: Record<string, any>,
    scriptSrcs: string[],
    metaTags: Record<string, string>,
    globals: string[],
  ) {
    let matches = 0;
    const patterns = sig.patterns || {};

    if (patterns.html) {
      for (const p of patterns.html) if (p.test(htmlLower)) matches++;
    }
    if (patterns.scripts) {
      for (const p of patterns.scripts) {
        for (const src of scriptSrcs) if (p.test(src)) matches++;
      }
    }
    if (patterns.meta) {
      for (const [n, p] of Object.entries(patterns.meta) as [string, RegExp][]) {
        if (metaTags[n.toLowerCase()] && p.test(metaTags[n.toLowerCase()])) matches++;
      }
    }
    if (patterns.headers) {
      for (const [h, p] of Object.entries(patterns.headers) as [string, RegExp][]) {
        if (headersLower[h.toLowerCase()] && p.test(headersLower[h.toLowerCase()])) matches++;
      }
    }
    if (patterns.globals && globals.length > 0) {
      for (const g of patterns.globals) if (globals.includes(g)) matches++;
    }

    if (matches >= 3) return 'high';
    if (matches >= 2) return 'medium';
    return 'low';
  }

  /**
   * Extract script sources from page
   * @private
   */
  static #extractScriptSources(parsedPage: ParsedPage | null, requests: Record<string, any>): string[] {
    const sources = new Set<string>();

    // From HTML
    if (parsedPage) {
      const scripts = parsedPage.querySelectorAll('script[src]');
      scripts.forEach((s) => {
        const src = s.getAttribute('src');
        if (src) sources.add(src.toLowerCase());
      });
    }

    // From network requests
    if (requests) {
      for (const [url, data] of Object.entries(requests)) {
        if (url.endsWith('.js') || (data.type && data.type.includes('script'))) {
          sources.add(url.toLowerCase());
        }
      }
    }

    return Array.from(sources);
  }

  /**
   * Extract meta tags from parsed page
   * @private
   */
  static #extractMetaTags(parsedPage: ParsedPage | null) {
    const tags: Record<string, string> = {};
    if (!parsedPage) return tags;

    const metas = parsedPage.querySelectorAll('meta');
    metas.forEach((meta) => {
      const name = meta.getAttribute('name') || meta.getAttribute('property');
      const content = meta.getAttribute('content');
      if (name && content) {
        tags[name.toLowerCase()] = content.toLowerCase();
      }
    });

    return tags;
  }

  /**
   * Extract meta tags from raw HTML
   * @private
   */
  static #extractMetaTagsFromHtml(html: string) {
    const tags: Record<string, string> = {};
    const metaRegex = /<meta[^>]*(?:name|property)=["']([^"']+)["'][^>]*content=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = metaRegex.exec(html)) !== null) {
      tags[match[1].toLowerCase()] = match[2].toLowerCase();
    }
    return tags;
  }

  /**
   * Lowercase all header keys
   * @private
   */
  static #lowercaseHeaders(headers: Record<string, any>) {
    const lower: Record<string, any> = {};
    for (const [key, value] of Object.entries(headers || {})) {
      lower[key.toLowerCase()] = typeof value === 'string' ? value.toLowerCase() : value;
    }
    return lower;
  }

  /**
   * Format category name
   * @private
   */
  static #formatCategory(category: string) {
    const names: Record<string, string> = {
      cms: 'CMS',
      frameworks: 'JavaScript Frameworks',
      cssFrameworks: 'CSS Frameworks',
      analytics: 'Analytics & Tracking',
      marketing: 'Marketing & CRM',
      cdn: 'CDN & Hosting',
      ecommerce: 'E-commerce & Payments',
      security: 'Security',
      media: 'Media & Video',
      fonts: 'Fonts',
      seo: 'SEO Tools',
      other: 'Other',
    };
    return names[category] || category;
  }
}

export { TechnologyDetector };
