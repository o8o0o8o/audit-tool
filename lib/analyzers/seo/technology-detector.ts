/**
 * Technology Detector
 * Detects CMS, frameworks, analytics, CDNs, and other technologies used on a page
 * Similar to Wappalyzer/BuiltWith
 */

import type { ChromePage, NetworkRequest, ParsedPage } from '../../types';

export interface TechSignaturePatterns {
  html?: RegExp[];
  meta?: Record<string, RegExp>;
  scripts?: RegExp[];
  headers?: Record<string, RegExp>;
  cookies?: RegExp[];
  globals?: string[];
  /**
   * Hosts that serve the technology's files (image CDN, asset API), matched against the HTML and the
   * script URLs. Reported as `asset-host`: it proves that files come from that service, not that the
   * site is built on it — a legacy CMS can use a headless CMS as an image store.
   */
  assetHosts?: RegExp[];
}

export interface TechSignature {
  name: string;
  patterns: TechSignaturePatterns;
}

export interface DetectionMethod {
  type: string;
  pattern?: string;
  matched?: string;
  tag?: string;
  value?: string;
  header?: string;
  variable?: string;
}

export interface DetectedTechnology {
  name: string;
  category: string;
  confidence: string;
  detectedBy: DetectionMethod[];
}

interface CategorySummary {
  category: string;
  count: number;
  technologies: string[];
}

/**
 * Drop `<pre>`/`<code>`/`<textarea>` content and HTML comments before fingerprinting: a blog post
 * quoting `'/_next/static'` or "webflow" in a code sample is not built with that stack.
 */
export function stripCodeBlocks(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(pre|code|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
}

class TechnologyDetector {
  // Technology signatures organized by category
  static SIGNATURES: Record<string, TechSignature[]> = {
    // Content Management Systems
    cms: [
      {
        name: 'WordPress',
        patterns: {
          html: [/wp-content/i, /wp-includes/i],
          meta: { generator: /wordpress/i },
          scripts: [/wp-content|wp-includes/i],
          // The REST API discovery header and the pingback header are sent by WordPress itself.
          headers: { link: /api\.w\.org/i, 'x-pingback': /xmlrpc\.php/i },
          cookies: [/(?:^|[\s,;])(?:wordpress_[a-z0-9_]+|wp-settings-\d+)=/i],
        },
      },
      {
        name: 'Drupal',
        patterns: {
          html: [/Drupal\.settings/i, /drupal\.js/i, /data-drupal-selector=|drupal-settings-json/i],
          meta: { generator: /drupal/i },
          headers: { 'x-drupal-cache': /./i, 'x-drupal-dynamic-cache': /./i, 'x-generator': /drupal/i },
        },
      },
      {
        name: 'Joomla',
        patterns: { html: [/\/media\/jui\//i, /joomla-script-options/i], meta: { generator: /joomla/i } },
      },
      {
        name: 'Shopify',
        patterns: {
          html: [/cdn\.shopify\.com/i, /Shopify\.theme/i],
          scripts: [/cdn\.shopify\.com/i],
          headers: { 'x-shopid': /./i, 'x-shopify-stage': /./i, 'powered-by': /shopify/i },
          cookies: [/(?:^|[\s,;])_shopify/i],
        },
      },
      {
        name: 'Squarespace',
        // A link to squarespace.com / wix.com / webflow.com / ghost.org in the page text is not a signal:
        // only the platforms' own asset hosts, markup and headers count.
        patterns: {
          html: [/static1\.squarespace\.com|squarespace-cdn\.com|static\.squarespace/i],
          scripts: [/static1\.squarespace\.com|squarespace-cdn\.com|assets\.squarespace\.com/i],
          headers: { server: /squarespace/i },
        },
      },
      {
        name: 'Wix',
        patterns: {
          html: [/static\.wixstatic\.com|static\.parastorage\.com/i],
          meta: { generator: /wix\.com/i },
          headers: { 'x-wix-request-id': /./i },
        },
      },
      {
        name: 'Webflow',
        patterns: {
          html: [/data-wf-(?:site|page)=/i, /assets\.website-files\.com|cdn\.prod\.website-files\.com/i],
          meta: { generator: /webflow/i },
          scripts: [/website-files\.com\/.*webflow[.\w-]*\.js/i],
        },
      },
      {
        name: 'Ghost',
        patterns: {
          meta: { generator: /ghost/i },
          html: [/data-ghost=/i],
          scripts: [/\/ghost\/(?:portal|sodo-search)|\/public\/cards\.min\.js/i],
        },
      },
      { name: 'Contentful', patterns: { scripts: [/\/contentful\./i], assetHosts: [/ctfassets\.net|cdn\.contentful\.com/i] } },
      { name: 'Sanity', patterns: { assetHosts: [/cdn\.sanity\.io|[a-z0-9]+\.api(?:cdn)?\.sanity\.io/i] } },
      { name: 'Strapi', patterns: { scripts: [/\/strapi\//i] } },
      {
        // The tracking script (hs-scripts.com) is the marketing product, not the CMS: only signals of a
        // page actually served by HubSpot CMS count here.
        name: 'HubSpot CMS',
        patterns: {
          html: [/hs_cos_wrapper/i, /\/_hcms\//i],
          meta: { generator: /hubspot/i },
          headers: { 'x-hs-hub-id': /./i },
        },
      },
      { name: 'BigCommerce', patterns: { html: [/bigcommerce/i], scripts: [/bigcommerce/i] } },
      {
        // PHPSESSID is set by any PHP application, so it is not a Magento signal.
        name: 'Magento',
        patterns: {
          html: [/mage\/cookies/i, /Magento_/i, /text\/x-magento-init/i],
          headers: { 'x-magento-tags': /./i, 'x-magento-cache-debug': /./i },
          cookies: [/(?:^|[\s,;])(?:frontend|mage-cache-sessid|mage-messages)=/i],
        },
      },
      { name: 'PrestaShop', patterns: { html: [/prestashop/i], meta: { generator: /prestashop/i } } },
      {
        name: 'Concrete CMS',
        patterns: {
          html: [/\/concrete\/(?:js|css|images|themes)\//i, /ccm_application_url|ccm_dispatcher_filename/i],
          scripts: [/\/concrete\/js\//i],
          meta: { generator: /concrete ?(?:5|cms)/i },
          cookies: [/(?:^|[\s,;])CONCRETE5?=/i],
          globals: ['CCM_APPLICATION_URL', 'CCM_DISPATCHER_FILENAME'],
        },
      },
      {
        name: 'TYPO3',
        patterns: {
          html: [/\/typo3conf\/|\/typo3temp\//i],
          meta: { generator: /typo3/i },
          cookies: [/(?:^|[\s,;])fe_typo_user=/i],
        },
      },
      {
        name: 'Craft CMS',
        // Craft sets its session cookie only once a session starts, so the public signals are the
        // generator tag (often from the SEOmatic plugin, which exists only for Craft), control-panel
        // resource paths and the CSRF field of its forms.
        patterns: {
          html: [/\/cpresources\/|name="craft_csrf_token"/i],
          meta: { generator: /craft cms|seomatic/i },
          cookies: [/CraftSessionId=/i],
          headers: { 'x-powered-by': /craft cms/i },
        },
      },
      { name: 'Contao', patterns: { meta: { generator: /contao/i } } },
      { name: 'ExpressionEngine', patterns: { cookies: [/(?:^|[\s,;])exp_[a-z_]+=/i] } },
      {
        name: 'Sitecore',
        patterns: { html: [/\/-\/(?:media|jssmedia)\//i], cookies: [/SC_ANALYTICS_GLOBAL_COOKIE=/i] },
      },
      { name: 'Adobe Experience Manager', patterns: { html: [/\/etc\.clientlibs\//i, /\/content\/dam\//i] } },
      { name: 'Optimizely CMS', patterns: { html: [/\/globalassets\/|\/contentassets\/|\/episerver\//i] } },
      {
        name: 'Kentico',
        patterns: {
          html: [/\/cmspages\/getresource\.ashx|\/getmedia\/[0-9a-f-]{36}\//i],
          cookies: [/CMSPreferredCulture=/i],
        },
      },
      { name: 'Umbraco', patterns: { html: [/\/umbraco\//i] } },
      { name: 'Sitefinity', patterns: { html: [/\/sitefinity\//i], meta: { generator: /sitefinity/i } } },
      {
        name: 'DNN',
        patterns: {
          html: [/\/desktopmodules\/|\/portals\/\d/i],
          meta: { generator: /dotnetnuke|dnn platform/i },
          cookies: [/(?:^|[\s,;])(?:\.dotnetnuke|dnn_ismobile)=/i],
        },
      },
      // Headless CMSs. Most are visible only through the host that serves their images or API, which is
      // an `asset-host` signal; a bridge / preview script or CMS-specific markup is a stronger one.
      {
        name: 'Storyblok',
        patterns: {
          scripts: [/app\.storyblok\.com\/f\/storyblok/i],
          assetHosts: [/a\.storyblok\.com|img2\.storyblok\.com/i],
        },
      },
      {
        name: 'Prismic',
        patterns: { scripts: [/static\.cdn\.prismic\.io\/prismic/i], assetHosts: [/images\.prismic\.io|\.cdn\.prismic\.io/i] },
      },
      { name: 'DatoCMS', patterns: { assetHosts: [/datocms-assets\.com/i] } },
      { name: 'Hygraph', patterns: { assetHosts: [/graphassets\.com|media\.graphcms\.com/i] } },
      { name: 'Contentstack', patterns: { assetHosts: [/contentstack\.io|assets\.contentstack\.com/i] } },
      { name: 'Kontent.ai', patterns: { assetHosts: [/kc-usercontent\.com/i] } },
      {
        name: 'Builder.io',
        patterns: { html: [/builder-content-id=|class="builder-block/i], assetHosts: [/cdn\.builder\.io/i] },
      },
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
          html: [/__NEXT_DATA__|_next\/static|_next\/image/i],
          scripts: [/_next\/static\//],
          headers: { 'x-powered-by': /next\.js/i, 'x-nextjs-cache': /./i, 'x-nextjs-prerender': /./i },
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
      {
        name: 'Nuxt.js',
        patterns: {
          html: [/__NUXT__/i],
          scripts: [/_nuxt\//],
          headers: { 'x-powered-by': /nuxt/i },
          globals: ['__NUXT__'],
        },
      },
      {
        name: 'Angular',
        patterns: {
          html: [/ng-version="/, /_ngcontent-/, /_nghost-/],
          scripts: [/\/@angular\//i],
        },
      },
      {
        // AngularJS 1.x is a different, end-of-life framework; `angular.min.js` is its file name.
        name: 'AngularJS',
        patterns: {
          html: [/\s(?:data-)?ng-(?:app|controller)\b/i],
          scripts: [/\/angular(?:js)?(?:[.-]\d[\d.]*)?(?:\.min)?\.js|\/angularjs\//i],
        },
      },
      {
        name: 'Svelte',
        patterns: { html: [/svelte-[a-z0-9]+|__svelte/], scripts: [/\/svelte\//i, /svelte\.min\.js/i] },
      },
      { name: 'SvelteKit', patterns: { html: [/__sveltekit/], scripts: [/sveltekit/i] } },
      {
        name: 'Gatsby',
        patterns: { html: [/id="___gatsby"|___gatsby/], scripts: [/\/gatsby-/i], meta: { generator: /^gatsby/i } },
      },
      { name: 'Remix', patterns: { html: [/__remixContext/i], globals: ['__remixContext'] } },
      {
        name: 'Astro',
        patterns: { html: [/astro-island|data-astro/], scripts: [/astro\/[a-z]/i], meta: { generator: /^astro/i } },
      },
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
        patterns: { html: [/class="[^"]*Mui[A-Z][a-z]+-root[^"]*"/i], scripts: [/\/@mui\//i, /\/material-ui\//i] },
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

  /** Window globals probed in the browser; every `globals` entry of a signature must be listed here to match. */
  static KNOWN_GLOBALS: string[] = [
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
    'CCM_APPLICATION_URL',
    'CCM_DISPATCHER_FILENAME',
  ];

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
    responseHeaders: Record<string, string> = {},
    requests: NetworkRequest[] | Record<string, { type?: string }> = {},
  ) {
    const detected = {
      technologies: [] as DetectedTechnology[],
      byCategory: {} as Record<string, string[]>,
      summary: {
        total: 0,
        categories: [] as CategorySummary[],
      },
    };

    const htmlLower = (htmlContent || '').toLowerCase();
    const headersLower = this.#lowercaseHeaders(responseHeaders);
    const scriptSrcs = this.#extractScriptSources(parsedPage, requests);
    const metaTags = this.#extractMetaTags(parsedPage);

    // Get global variables from browser context
    let globals: string[] = [];
    try {
      const result = await chromePage.evaluate((knownGlobals: string[]) => {
        return knownGlobals.filter((g) => {
          try {
            return typeof (window as unknown as Record<string, unknown>)[g] !== 'undefined';
          } catch {
            return false;
          }
        });
      }, TechnologyDetector.KNOWN_GLOBALS);
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
      .filter(([_, techs]) => techs.length > 0)
      .map(([cat, techs]) => ({
        category: this.#formatCategory(cat),
        count: techs.length,
        technologies: techs,
      }));

    return detected;
  }

  /**
   * Quick detection without browser context (for faster analysis).
   * `globals` lets a caller that did read the page in a browser pass the window globals it found.
   */
  static detectFromHtml(
    htmlContent: string,
    responseHeaders: Record<string, string> = {},
    scriptSrcs: string[] = [],
    globals: string[] = [],
  ) {
    const detected = {
      technologies: [] as DetectedTechnology[],
      byCategory: {} as Record<string, string[]>,
      summary: { total: 0, categories: [] as CategorySummary[] },
    };

    const htmlLower = (htmlContent || '').toLowerCase();
    const headersLower = this.#lowercaseHeaders(responseHeaders);
    const metaTags = this.#extractMetaTagsFromHtml(htmlContent);

    for (const [category, signatures] of Object.entries(this.SIGNATURES)) {
      detected.byCategory[category] = [];

      for (const sig of signatures) {
        const detectionMethods = this.#matchSignature(sig, htmlLower, headersLower, scriptSrcs, metaTags, globals);
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
      .filter(([_, techs]) => techs.length > 0)
      .map(([cat, techs]) => ({
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
    sig: TechSignature,
    htmlLower: string,
    headersLower: Record<string, string>,
    scriptSrcs: string[],
    metaTags: Record<string, string>,
    globals: string[],
  ) {
    const patterns = sig.patterns || {};
    const methods: DetectionMethod[] = [];

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

    // Check asset hosts (HTML and script URLs)
    if (patterns.assetHosts) {
      for (const pattern of patterns.assetHosts) {
        const inHtml = pattern.exec(htmlLower);
        const hit = inHtml?.[0] ?? scriptSrcs.map((src) => pattern.exec(src)?.[0]).find(Boolean);
        if (hit) {
          methods.push({ type: 'asset-host', pattern: pattern.source, matched: hit.substring(0, 60) });
          break;
        }
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
    sig: TechSignature,
    htmlLower: string,
    headersLower: Record<string, string>,
    scriptSrcs: string[],
    metaTags: Record<string, string>,
    globals: string[],
  ) {
    let matches = 0;
    const patterns = sig.patterns || {};

    if (patterns.html) {
      for (const p of patterns.html) if (p.test(htmlLower)) matches++;
    }
    if (patterns.assetHosts) {
      for (const p of patterns.assetHosts) if (p.test(htmlLower) || scriptSrcs.some((src) => p.test(src))) matches++;
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
  static #extractScriptSources(
    parsedPage: ParsedPage | null,
    requests: NetworkRequest[] | Record<string, { type?: string }>,
  ): string[] {
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
      if (Array.isArray(requests)) {
        for (const req of requests) {
          if (req.url.endsWith('.js') || req.resourceType?.includes('script')) {
            sources.add(req.url.toLowerCase());
          }
        }
      } else {
        for (const [url, data] of Object.entries(requests)) {
          if (url.endsWith('.js') || data.type?.includes('script')) {
            sources.add(url.toLowerCase());
          }
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
      const name = meta.getAttribute('name') ?? meta.getAttribute('property');
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
    // Match each <meta> tag, then extract name/property and content
    // independently so attribute order doesn't matter
    // (e.g. `<meta content="…" name="generator">` was previously missed).
    const metaTagRegex = /<meta\b[^>]*>/gi;
    let tagMatch;
    while ((tagMatch = metaTagRegex.exec(html)) !== null) {
      const tag = tagMatch[0];
      const nameMatch = tag.match(/(?:name|property)=["']([^"']+)["']/i);
      const contentMatch = tag.match(/content=["']([^"']+)["']/i);
      if (nameMatch && contentMatch) {
        tags[nameMatch[1].toLowerCase()] = contentMatch[1].toLowerCase();
      }
    }
    return tags;
  }

  /**
   * Lowercase header keys AND values. Every header and cookie pattern therefore needs the `i` flag
   * (or an all-lowercase source); the same holds for `html` and `scripts` patterns, which are matched
   * against lowercased input. `tests/technology-detector.test.ts` guards this for every signature.
   * @private
   */
  static #lowercaseHeaders(headers: Record<string, string>) {
    const lower: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers || {})) {
      lower[key.toLowerCase()] = typeof value === 'string' ? value.toLowerCase() : String(value);
    }
    return lower;
  }

  /**
   * Quick detection: return the first matching JS framework name or null.
   * Lighter alternative to the full detect()/detectFromHtml() methods.
   */
  static quickDetectFramework(html: string): string | null {
    const lower = stripCodeBlocks(html).toLowerCase();
    for (const sig of this.SIGNATURES.frameworks) {
      if (sig.patterns.html?.some((p) => p.test(lower))) return sig.name;
    }
    return null;
  }

  /**
   * Quick detection: return the first matching CMS name or null.
   */
  static quickDetectCMS(html: string): string | null {
    const lower = stripCodeBlocks(html).toLowerCase();
    for (const sig of this.SIGNATURES.cms) {
      if (sig.patterns.html?.some((p) => p.test(lower))) return sig.name;
    }
    // An asset host is the weakest signal: only when no CMS shows in the markup itself.
    for (const sig of this.SIGNATURES.cms) {
      if (sig.patterns.assetHosts?.some((p) => p.test(lower))) return sig.name;
    }
    return null;
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
