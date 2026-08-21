/**
 * Extended fix-recommendation entries — one per analyzer message that lacked
 * curated guidance in the original FIX_RECOMMENDATIONS map.
 *
 * Keys are the analyzer message in its "lookup" canonical form: leading
 * `<count> ` / `<pct>% of ` prefixes stripped, trailing `(N units)` tokens
 * stripped, HTML tags stripped. The Phase 2 lookup in
 * `lib/phase2/phase2-runner.ts` runs the runtime message through both
 * `normalizeMessage` and `normalizeMessageForLookup`, so either form matches.
 *
 * Data only — no logic. Sorted by topic for review-ability, not alphabetically.
 */

import type { FixRecommendation } from '../types';

export const EXTENDED_FIX_RECOMMENDATIONS: Record<string, FixRecommendation> = {
  // ─── Security: SSL / TLS / HTTPS ──────────────────────────────────────────
  'SSL certificate is invalid': {
    effort: '1-2 hours',
    fix: 'Replace the invalid certificate immediately. Use Let\'s Encrypt (free, automated) or your CDN/host\'s managed certificate. Verify the certificate chain is complete and the hostname matches.',
    example: 'sudo certbot --nginx -d example.com -d www.example.com',
    resources: [
      { text: 'Let\'s Encrypt', url: 'https://letsencrypt.org/getting-started/' },
      { text: 'SSL Labs Test', url: 'https://www.ssllabs.com/ssltest/' },
    ],
  },
  'SSL certificate has expired': {
    effort: '30 minutes',
    fix: 'Renew the certificate immediately. Set up auto-renewal (certbot/acme.sh) so this never happens again. Monitor expiry with an external uptime tool.',
    example: 'sudo certbot renew --force-renewal\n# Schedule: 0 3 * * * certbot renew --quiet',
    resources: [{ text: 'Certbot Auto-Renewal', url: 'https://eff-certbot.readthedocs.io/en/latest/using.html#automated-renewals' }],
  },
  'SSL certificate expiring very soon': {
    effort: '30 minutes',
    fix: 'Renew the certificate now — fewer than 7 days remain. Configure automatic renewal so future renewals happen 30 days before expiry.',
    example: 'certbot renew --force-renewal',
    resources: [{ text: 'Renewing certificates', url: 'https://eff-certbot.readthedocs.io/en/latest/using.html#renewing-certificates' }],
  },
  'SSL certificate expiring soon': {
    effort: '30 minutes',
    fix: 'Schedule a renewal in the next maintenance window. Verify auto-renewal cron/service is healthy and check renewal logs.',
    example: 'systemctl status certbot.timer\njournalctl -u certbot',
    resources: [],
  },
  'Failed to analyze SSL certificate': {
    effort: '30 minutes',
    fix: 'Investigate why the TLS handshake failed: hostname mismatch, network/firewall block, server requires SNI, or unsupported protocol version. Run an external scan to confirm.',
    example: 'openssl s_client -connect example.com:443 -servername example.com',
    resources: [{ text: 'SSL Labs Test', url: 'https://www.ssllabs.com/ssltest/' }],
  },
  'SSL certificate error': {
    effort: '1 hour',
    fix: 'Diagnose the certificate problem (expired intermediate, wrong chain order, hostname mismatch, self-signed). Reissue from a trusted CA and deploy the full chain.',
    example: 'openssl s_client -connect example.com:443 -showcerts',
    resources: [{ text: 'SSL Labs Test', url: 'https://www.ssllabs.com/ssltest/' }],
  },
  'Hostname mismatch': {
    effort: '30 minutes',
    fix: 'The certificate does not cover the hostname being served. Reissue the certificate with the correct Subject Alternative Names (SANs), or serve the correct certificate for this hostname (check SNI/vhost config).',
    example: 'certbot certonly --nginx -d example.com -d www.example.com -d api.example.com',
    resources: [],
  },
  'Self-signed certificate detected': {
    effort: '30 minutes',
    fix: 'Replace the self-signed certificate with one from a trusted CA (Let\'s Encrypt is free). Browsers reject self-signed certs in production.',
    example: 'sudo certbot --nginx -d example.com',
    resources: [{ text: 'Let\'s Encrypt', url: 'https://letsencrypt.org/getting-started/' }],
  },
  'Outdated TLS version': {
    effort: '20 minutes',
    fix: 'Disable TLS 1.0 and 1.1. Require TLS 1.2 minimum; enable TLS 1.3 for better performance and forward secrecy.',
    example: 'nginx:\nssl_protocols TLSv1.2 TLSv1.3;\nssl_prefer_server_ciphers off;',
    resources: [{ text: 'Mozilla SSL Config', url: 'https://ssl-config.mozilla.org/' }],
  },
  'Weak cipher suite detected': {
    effort: '20 minutes',
    fix: 'Disable weak ciphers (RC4, 3DES, EXPORT, NULL). Use the Mozilla "intermediate" or "modern" cipher list.',
    example: 'ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:...;',
    resources: [{ text: 'Mozilla SSL Config', url: 'https://ssl-config.mozilla.org/' }],
  },
  'Page not using HTTPS': {
    effort: '1-2 hours',
    fix: 'Serve every page over HTTPS. Redirect HTTP→HTTPS (301), set HSTS, and update internal links/canonicals to HTTPS.',
    example: 'nginx:\nserver { listen 80; return 301 https://$host$request_uri; }\nadd_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
    resources: [{ text: 'HTTPS Migration', url: 'https://web.dev/articles/why-https-matters' }],
  },
  'Site not using HTTPS': {
    effort: '2-4 hours',
    fix: 'Migrate the entire site to HTTPS. Obtain a certificate (Let\'s Encrypt), force HTTPS via 301 redirect, enable HSTS, update canonicals, hreflang, and sitemap to HTTPS.',
    example: 'Combine certbot + nginx HTTPS redirect + HSTS header in one deploy step.',
    resources: [
      { text: 'HTTPS Migration', url: 'https://web.dev/articles/why-https-matters' },
      { text: 'Google HTTPS Guide', url: 'https://developers.google.com/search/docs/crawling-indexing/site-move-with-url-changes' },
    ],
  },
  'Some pages still on HTTP': {
    effort: '30 minutes',
    fix: 'Audit which pages serve over HTTP and add 301 redirects to their HTTPS counterparts. Update internal links pointing to HTTP URLs.',
    example: 'nginx:\nserver { listen 80; server_name example.com; return 301 https://$host$request_uri; }',
    resources: [],
  },

  // ─── Security: Mixed content ─────────────────────────────────────────────
  'Active mixed content detected (blocked)': {
    effort: '30 minutes',
    fix: 'Find every http:// reference in <script>, <iframe>, <link rel="stylesheet">, XHR/fetch calls and rewrite to https://. Browsers block these outright on HTTPS pages.',
    example: 'Replace <script src="http://cdn.../jquery.js"> with <script src="https://cdn.../jquery.js"> or self-host.',
    resources: [{ text: 'Mixed Content', url: 'https://web.dev/articles/what-is-mixed-content' }],
  },
  'Active mixed content across site': {
    effort: '2-4 hours',
    fix: 'Site-wide audit of active mixed content. Use Content-Security-Policy: upgrade-insecure-requests as a stop-gap while you fix sources. Search source for http:// and replace with https:// or protocol-relative URLs.',
    example: 'Content-Security-Policy: upgrade-insecure-requests',
    resources: [{ text: 'Fixing Mixed Content', url: 'https://web.dev/articles/fixing-mixed-content' }],
  },
  'Passive mixed content detected': {
    effort: '20 minutes',
    fix: 'Replace http:// references in <img>, <audio>, <video> tags with https:// URLs. Browsers warn (and may upgrade) — newer browsers block by default.',
    example: '<img src="https://cdn.example.com/photo.jpg">',
    resources: [{ text: 'Mixed Content', url: 'https://web.dev/articles/what-is-mixed-content' }],
  },
  'Passive mixed content across site': {
    effort: '1 hour',
    fix: 'Sweep the site for http:// in src attributes. Use Content-Security-Policy: upgrade-insecure-requests to auto-upgrade safe loads while you replace at source.',
    example: 'Content-Security-Policy: upgrade-insecure-requests',
    resources: [{ text: 'Fixing Mixed Content', url: 'https://web.dev/articles/fixing-mixed-content' }],
  },
  'Form submits to insecure HTTP URL': {
    effort: '20 minutes',
    fix: 'Change every <form action="http://...">  to use https://. Submitting credentials/PII over HTTP leaks data in transit and most browsers warn the user.',
    example: '<form action="https://example.com/login" method="post">',
    resources: [{ text: 'Mixed Content Forms', url: 'https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content' }],
  },
  'Internal links use HTTP instead of HTTPS': {
    effort: '30 minutes',
    fix: 'Update internal href values to https:// (or use root-relative /path links). Inconsistent protocols hurt crawling and create redirect chains.',
    example: '<a href="/about">About</a>   or   <a href="https://example.com/about">About</a>',
    resources: [],
  },
  'Mixed HTTP/HTTPS URLs detected': {
    effort: '30 minutes',
    fix: 'Pick HTTPS as the canonical protocol, then update sitemap, canonical tags, hreflang, internal links and 301-redirect HTTP→HTTPS.',
    resources: [],
  },

  // ─── Security: CSP / headers / info disclosure ───────────────────────────
  'Content-Security-Policy missing recommended directives': {
    effort: '1 hour',
    fix: 'Strengthen CSP by adding object-src \'none\', base-uri \'self\', frame-ancestors \'none\' (or \'self\'), and tightening script-src/style-src. Use nonces or hashes instead of \'unsafe-inline\'.',
    example: "Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-abc'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    resources: [{ text: 'CSP', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP' }],
  },
  'Server version disclosed in response headers': {
    effort: '10 minutes',
    fix: 'Hide the server version. Set Server header to a generic value or remove it. Reduces fingerprinting for known-CVE exploitation.',
    example: 'nginx: server_tokens off;\napache: ServerTokens Prod\nServerSignature Off',
    resources: [],
  },
  'Server technology disclosed in response headers': {
    effort: '10 minutes',
    fix: 'Remove X-Powered-By, X-AspNet-Version, X-Generator, etc. Strip via reverse proxy or framework setting.',
    example: 'express: app.disable("x-powered-by");\nnginx: proxy_hide_header X-Powered-By;',
    resources: [],
  },
  'Potentially sensitive information in HTML comments': {
    effort: '30 minutes',
    fix: 'Strip development/debug comments from production HTML. They may leak paths, API keys, internal hostnames, or TODO/security notes.',
    example: 'Configure your bundler to strip HTML comments in production (Webpack html-minifier-terser: removeComments: true).',
    resources: [],
  },
  'Source maps exposed in production': {
    effort: '15 minutes',
    fix: 'Do not publish .map files to production, or restrict them by IP / require auth. Source maps reveal original source code and structure.',
    example: 'webpack: devtool: false (production) — or upload sourcemaps to Sentry only.',
    resources: [],
  },
  'Potential open redirect in page URL parameters': {
    effort: '30 minutes',
    fix: 'Validate redirect targets server-side: allow-list known internal paths, or check the target hostname matches yours. Never blindly redirect to user-supplied URLs.',
    example: 'const allowed = ["/dashboard", "/account"];\nif (!allowed.includes(target)) return res.redirect("/");',
    resources: [{ text: 'OWASP Unvalidated Redirects', url: 'https://owasp.org/www-community/attacks/Open_redirect' }],
  },
  'Overpermissive Permissions-Policy directives': {
    effort: '15 minutes',
    fix: 'Tighten Permissions-Policy: explicitly deny features you do not use (camera, microphone, geolocation, payment). Allow only the origins that need them.',
    example: 'Permissions-Policy: camera=(), microphone=(), geolocation=(self), payment=()',
    resources: [{ text: 'Permissions Policy', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy' }],
  },
  'External stylesheets missing Subresource Integrity (SRI)': {
    effort: '15 minutes',
    fix: 'Add integrity + crossorigin to all <link rel="stylesheet" href="https://cdn..."> tags so a compromised CDN cannot inject styles.',
    example: '<link rel="stylesheet" href="https://cdn.example.com/lib.css" integrity="sha384-..." crossorigin="anonymous">',
    resources: [{ text: 'SRI', url: 'https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity' }],
  },

  // ─── Privacy / cookies / consent ─────────────────────────────────────────
  'Cookies with excessive lifespan': {
    effort: '20 minutes',
    fix: 'Cap cookie Max-Age at 13 months (GDPR/CNIL guidance is 13 months for consent records and tracking). Refresh consent yearly rather than setting multi-year cookies.',
    example: 'Set-Cookie: session=abc; Max-Age=33696000; Secure; HttpOnly; SameSite=Lax',
    resources: [{ text: 'CNIL Cookie Guidance', url: 'https://www.cnil.fr/en/cookies-and-other-tracking-devices' }],
  },
  'Tracking cookies without consent banner': {
    effort: '4-8 hours',
    fix: 'Add a consent banner (e.g. Cookiebot, Osano, OneTrust, or a self-built minimal solution) that blocks tracking cookies until the user opts in. Required by GDPR/ePrivacy.',
    example: '// Defer GA until consent:\nif (consent.analytics) loadGA();',
    resources: [{ text: 'Consent Mode v2', url: 'https://developers.google.com/tag-platform/security/guides/consent' }],
  },
  'Multiple tracking cookies set before consent': {
    effort: '1-2 hours',
    fix: 'Audit which scripts set cookies on load and gate them behind consent. Use Google Consent Mode v2 or set cookies only after explicit opt-in.',
    example: 'gtag("consent", "default", { ad_storage: "denied", analytics_storage: "denied" });',
    resources: [{ text: 'Consent Mode v2', url: 'https://developers.google.com/tag-platform/security/guides/consent' }],
  },
  'Third-party cookies without consent': {
    effort: '1-2 hours',
    fix: 'Block third-party embeds (YouTube, Maps, social, ads) until the user consents. Use facade patterns (e.g. lite-youtube-embed) that load the embed only on click.',
    example: '<lite-youtube videoid="abc123"></lite-youtube>',
    resources: [{ text: 'lite-youtube-embed', url: 'https://github.com/paulirish/lite-youtube-embed' }],
  },
  'Inconsistent cookie consent implementation': {
    effort: '2-4 hours',
    fix: 'Standardize on one consent platform across every page and language variant. Inconsistent implementations leak tracking on some pages and break compliance.',
    resources: [],
  },
  'Custom consent implementation detected': {
    effort: '1 hour',
    fix: 'Review the custom banner against GDPR/ePrivacy: clear opt-in, no pre-checked boxes, equally prominent reject button, easy withdrawal. Consider a vetted CMP (Cookiebot, OneTrust).',
    resources: [{ text: 'TCF Compliance', url: 'https://iabeurope.eu/transparency-consent-framework/' }],
  },
  'Multiple cookie consent tools detected': {
    effort: '1 hour',
    fix: 'Remove duplicate consent libraries — they collide, double-prompt, and corrupt consent state. Keep one CMP and remove others.',
    resources: [],
  },
  'Multiple consent platforms detected': {
    effort: '1 hour',
    fix: 'Audit which consent platform is the source of truth. Remove competing scripts so only one platform records and propagates consent.',
    resources: [],
  },
  'No privacy policy link found': {
    effort: '30 minutes',
    fix: 'Add a visible link to your privacy policy in the footer of every page. Required by GDPR/CCPA and most cookie regulations.',
    example: '<footer><a href="/privacy">Privacy Policy</a></footer>',
    resources: [],
  },
  'Privacy policy link missing on many pages': {
    effort: '30 minutes',
    fix: 'Move the privacy policy link into the global footer/layout component so it is present on every page. Required for compliance and trust.',
    example: '// In your root layout component:\n<Footer><a href="/privacy">Privacy</a></Footer>',
    resources: [],
  },
  'Many pages lack privacy policy link': {
    effort: '30 minutes',
    fix: 'Add the privacy policy link to the shared layout/footer so every page links to it.',
    resources: [],
  },

  // ─── Indexability / robots / sitemap ─────────────────────────────────────
  'Low site indexability': {
    effort: '2-4 hours',
    fix: 'Less than 50% of the site is indexable. Audit noindex tags, X-Robots-Tag headers, canonical chains, and robots.txt rules to find the cause.',
    resources: [{ text: 'Indexing Issues', url: 'https://developers.google.com/search/docs/crawling-indexing/block-indexing' }],
  },
  'Pages in sitemap are marked noindex': {
    effort: '30 minutes',
    fix: 'Pages in the sitemap should be indexable. Either remove noindex (if you want them indexed) or remove the page from the sitemap.',
    example: '<!-- remove this from indexable pages -->\n<meta name="robots" content="noindex">',
    resources: [],
  },
  'Pages require authentication': {
    effort: '1 hour',
    fix: 'Pages returning 401/403 to Googlebot cannot be indexed. Either make the page public (and add to sitemap), or remove auth-gated pages from the sitemap and add noindex.',
    resources: [],
  },
  'Indexable pages missing from sitemap': {
    effort: '30 minutes',
    fix: 'Add discovered indexable pages to sitemap.xml. Missing entries delay indexing.',
    example: '<url><loc>https://example.com/new-page</loc><lastmod>2025-12-09</lastmod></url>',
    resources: [{ text: 'Sitemap Guide', url: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap' }],
  },
  'High percentage of non-indexable pages': {
    effort: '1 hour',
    fix: 'Investigate why so many pages are blocked from indexing. Common causes: aggressive noindex, canonical chains pointing offsite, wrong X-Robots-Tag, robots.txt over-blocking.',
    resources: [],
  },
  'Pages have nofollow directive': {
    effort: '20 minutes',
    fix: 'Remove site-wide nofollow on internal links — it prevents PageRank flow and crawl discovery. Use nofollow only on UGC or sponsored content.',
    example: '<a href="/internal-page">Internal page</a>   <!-- NOT rel="nofollow" -->',
    resources: [],
  },
  'page(s) blocked via X-Robots-Tag: noindex': {
    effort: '30 minutes',
    fix: 'Audit which pages serve X-Robots-Tag: noindex. If they should be indexed, remove the header at the CDN/server level. If they should not, also remove them from the sitemap.',
    example: 'nginx: location ~ ^/private/ { add_header X-Robots-Tag "noindex, nofollow"; }',
    resources: [],
  },
  'Many pages canonicalized to other URLs': {
    effort: '1 hour',
    fix: 'Many pages declare a canonical to a different URL. Investigate whether canonicals point to the right authoritative version; cross-domain or chained canonicals waste crawl budget.',
    resources: [{ text: 'Canonicalization', url: 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls' }],
  },
  'Many pages with non-self-referencing canonicals': {
    effort: '30 minutes',
    fix: 'Self-referencing canonicals are the safest default. Audit why many pages canonical to other URLs — fix if accidental.',
    example: '<link rel="canonical" href="https://example.com/this-page">',
    resources: [],
  },
  'Conflicting robots directives': {
    effort: '20 minutes',
    fix: 'A page has contradictory directives (e.g. <meta name="robots" content="index"> + X-Robots-Tag: noindex, or robots.txt Allow + Disallow conflict). Decide the intent and remove the wrong one.',
    resources: [],
  },
  'AI crawlers blocked in robots.txt': {
    effort: '15 minutes',
    fix: 'If you want to be cited by ChatGPT, Perplexity, Claude, etc., do not blanket-disallow GPTBot, ClaudeBot, PerplexityBot, etc. Decide policy per-bot for training vs. retrieval.',
    example: 'User-agent: GPTBot\nAllow: /\n\nUser-agent: ClaudeBot\nAllow: /',
    resources: [{ text: 'AI Crawlers', url: 'https://platform.openai.com/docs/gptbot' }],
  },
  'Important bots blocked by wildcard rules': {
    effort: '20 minutes',
    fix: 'A wildcard Disallow blocks important bots (Googlebot, Bingbot). Move bot-specific rules above the wildcard rule, since robots.txt matches the longest applicable User-agent group.',
    example: 'User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /private/',
    resources: [{ text: 'robots.txt spec', url: 'https://developers.google.com/search/docs/crawling-indexing/robots/intro' }],
  },
  'Conflicting rules in robots.txt': {
    effort: '15 minutes',
    fix: 'Robots.txt has overlapping Allow/Disallow rules that cause ambiguous matching. Reorder rules — Google uses longest-match wins — and remove redundant directives.',
    resources: [],
  },
  'Allow rule without User-agent': {
    effort: '5 minutes',
    fix: 'An Allow rule appears outside a User-agent group. Move it under a specific User-agent (or `User-agent: *`) so it applies.',
    example: 'User-agent: *\nAllow: /public/',
    resources: [],
  },
  'Disallow rule without User-agent': {
    effort: '5 minutes',
    fix: 'A Disallow rule appears outside a User-agent group. Move it under a specific User-agent block.',
    example: 'User-agent: *\nDisallow: /admin/',
    resources: [],
  },
  'High crawl-delay may slow indexing': {
    effort: '5 minutes',
    fix: 'Reduce or remove `Crawl-delay` in robots.txt — large values significantly slow indexing. Googlebot ignores it but Bingbot/Yandex honor it.',
    example: 'User-agent: *\nCrawl-delay: 1   # or remove entirely',
    resources: [],
  },
  'Sensitive paths exposed in robots.txt': {
    effort: '20 minutes',
    fix: 'Do not list sensitive paths in robots.txt — it is publicly readable and advertises what to attack. Block access via auth/firewall instead, and skip the Disallow.',
    resources: [],
  },
  'Invalid sitemap URL in robots.txt': {
    effort: '5 minutes',
    fix: 'The Sitemap: directive in robots.txt must be a fully-qualified absolute URL. Fix the URL or remove the broken directive.',
    example: 'Sitemap: https://example.com/sitemap.xml',
    resources: [],
  },
  'No sitemap declared in robots.txt': {
    effort: '5 minutes',
    fix: 'Add Sitemap: directives to robots.txt so crawlers can discover your sitemap(s).',
    example: 'Sitemap: https://example.com/sitemap.xml',
    resources: [{ text: 'Sitemaps', url: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview' }],
  },
  'robots.txt exceeds size limit': {
    effort: '20 minutes',
    fix: 'Googlebot parses up to 500 KiB of robots.txt — anything beyond is ignored. Consolidate rules, remove comments, and split traffic by subdomain if needed.',
    resources: [{ text: 'robots.txt Limits', url: 'https://developers.google.com/search/docs/crawling-indexing/robots/intro' }],
  },
  'robots.txt is empty': {
    effort: '10 minutes',
    fix: 'Replace the empty file with a minimal valid robots.txt that allows crawling and declares your sitemap.',
    example: 'User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml',
    resources: [],
  },
  'robots.txt not found': {
    effort: '10 minutes',
    fix: 'Add /robots.txt at the site root. Empty or missing robots.txt is fine for small sites, but a present file is the recommended default.',
    example: 'User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml',
    resources: [],
  },
  'Error fetching robots.txt': {
    effort: '30 minutes',
    fix: 'robots.txt returned an HTTP error. If 4xx, host an empty robots.txt to avoid crawler confusion. If 5xx, fix the server — Googlebot will pause crawling on persistent 5xx.',
    resources: [{ text: 'robots.txt errors', url: 'https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt#handling-http-result-codes' }],
  },

  // ─── Sitemap ─────────────────────────────────────────────────────────────
  'There are duplications in sitemap': {
    effort: '20 minutes',
    fix: 'Remove duplicate <loc> entries. Each URL should appear once. Trailing slash and protocol differences count as duplicates.',
    resources: [],
  },
  'Incorrect origin in sitemap': {
    effort: '15 minutes',
    fix: 'All <loc> URLs must use the same origin (scheme + host + port) as the sitemap location. Cross-host entries are ignored.',
    example: 'If sitemap is at https://www.example.com/sitemap.xml, every <loc> must start with https://www.example.com/',
    resources: [],
  },
  'Invalid URL format in sitemap': {
    effort: '20 minutes',
    fix: 'Each <loc> must be a valid absolute URL. Remove malformed entries and re-validate sitemap with Google Search Console.',
    example: '<url><loc>https://example.com/page</loc></url>',
    resources: [],
  },
  'Empty or missing in sitemap': {
    effort: '20 minutes',
    fix: 'The sitemap has empty or missing <loc> entries. Regenerate from your CMS/build script and validate before deploying.',
    resources: [],
  },
  'Sitemap index contains non-absolute <loc> URLs': {
    effort: '15 minutes',
    fix: 'Every <loc> in a sitemap index must be a fully-qualified absolute URL, not a path. Usually caused by a misconfigured base-URL setting in the sitemap generator (e.g. a Hugo site with baseURL set to "/"). A relative loc here risks the whole nested sitemap — or the entire index — being ignored by search engines.',
    example: '<sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>   <!-- NOT <loc>/sitemap-pages.xml</loc> -->',
    resources: [{ text: 'Sitemap Guide', url: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap' }],
  },
  'Sitemap contains non-absolute <loc> URLs': {
    effort: '15 minutes',
    fix: 'Every <loc> in a sitemap must be a fully-qualified absolute URL, not a path. Usually caused by a misconfigured base-URL setting in the sitemap generator. Narrower impact than the same issue on a sitemap index — only this sitemap\'s URLs are affected.',
    example: '<url><loc>https://example.com/page</loc></url>   <!-- NOT <loc>/page</loc> -->',
    resources: [{ text: 'Sitemap Guide', url: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap' }],
  },
  'Sitemap URL uses HTTP instead of HTTPS': {
    effort: '5 minutes',
    fix: 'Use https:// for every <loc> entry. HTTP entries trigger redirect chains and waste crawl budget.',
    resources: [],
  },
  'Sitemap is reached the limit': {
    effort: '30 minutes',
    fix: 'Sitemaps are capped at 50,000 URLs and 50 MB uncompressed. Split into multiple sitemaps and reference them from a sitemap index.',
    example: '<sitemapindex><sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>...</sitemapindex>',
    resources: [{ text: 'Sitemap Index', url: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/large-sitemaps' }],
  },
  'Failed to fetch nested sitemap': {
    effort: '20 minutes',
    fix: 'A sitemap referenced by the index is unreachable. Check that the URL returns 200 OK and is valid XML.',
    resources: [],
  },
  'Failed to process nested sitemap': {
    effort: '20 minutes',
    fix: 'A nested sitemap failed to parse — likely invalid XML or encoding. Validate with a sitemap-validator tool and fix the underlying file.',
    resources: [],
  },
  'Trailing slash inconsistencies in sitemap': {
    effort: '15 minutes',
    fix: 'Pick one form (with or without trailing slash) and apply it consistently in the sitemap. Mixed forms create duplicate-content confusion.',
    resources: [],
  },
  'Trailing-slash duplicate URL pairs in sitemap': {
    effort: '15 minutes',
    fix: 'The sitemap lists both /foo and /foo/ for the same content. Choose one form, remove the other, and 301-redirect the dropped form to the kept one.',
    resources: [],
  },
  'Static routes not found in sitemap': {
    effort: '20 minutes',
    fix: 'Your static routes are not in the sitemap. Regenerate the sitemap from the route table so every public route is listed.',
    resources: [],
  },
  'Pages blocked by robots.txt in sitemap': {
    effort: '15 minutes',
    fix: 'Pages cannot be both disallowed in robots.txt and listed in the sitemap. Decide intent: either remove from sitemap or unblock in robots.txt.',
    resources: [],
  },

  // ─── International / hreflang ─────────────────────────────────────────────
  'Hreflang alternate URLs are not fully qualified': {
    effort: '20 minutes',
    fix: 'hreflang href values must be absolute URLs (https://...) — relative URLs are ignored by Google.',
    example: '<link rel="alternate" hreflang="de" href="https://example.com/de/page">',
    resources: [{ text: 'hreflang', url: 'https://developers.google.com/search/docs/specialty/international/localized-versions' }],
  },
  'Duplicate hreflang assignment within language group': {
    effort: '20 minutes',
    fix: 'The same language code points to multiple URLs on a single page. Each hreflang must be unique within a page; consolidate the duplicates.',
    resources: [],
  },
  'Incomplete bidirectional hreflang links': {
    effort: '30 minutes',
    fix: 'hreflang must be reciprocal: if A links to B with hreflang="de", B must link back to A with hreflang="en". Add the missing reverse links.',
    resources: [{ text: 'Reciprocal hreflang', url: 'https://developers.google.com/search/docs/specialty/international/localized-versions#bi-directional' }],
  },
  'Many pages missing hreflang on multilanguage site': {
    effort: '1-2 hours',
    fix: 'Add hreflang annotations to every language variant. Easiest at the layout level (head injection) or via HTTP Link headers / sitemap-based hreflang.',
    example: '<link rel="alternate" hreflang="en" href="https://example.com/en/">\n<link rel="alternate" hreflang="x-default" href="https://example.com/">',
    resources: [{ text: 'hreflang', url: 'https://developers.google.com/search/docs/specialty/international/localized-versions' }],
  },
  'Pages missing self-referential hreflang': {
    effort: '15 minutes',
    fix: 'Every page in an hreflang cluster must link to itself with its own hreflang. Add the self-referential <link rel="alternate" hreflang="X" href="self">.',
    resources: [],
  },
  'Many pages missing x-default hreflang': {
    effort: '15 minutes',
    fix: 'Add an x-default hreflang pointing to the fallback page for users whose language is not covered.',
    example: '<link rel="alternate" hreflang="x-default" href="https://example.com/">',
    resources: [],
  },
  'Multiple pages linked for the same hreflang on a single page': {
    effort: '20 minutes',
    fix: 'A page declares the same hreflang code more than once. Pick one canonical href per language and remove the rest.',
    resources: [],
  },
  'Inconsistent international URL structure': {
    effort: '1 hour',
    fix: 'Mixing /en/, ?lang=en, en.example.com and example.com/en across pages confuses crawlers. Standardize on one strategy (subdir, subdomain, or ccTLD).',
    resources: [{ text: 'International Site Structure', url: 'https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites' }],
  },
  'Significant content length disparity across languages': {
    effort: '2-4 hours',
    fix: 'Some language variants have far less content. Translate missing sections or remove the under-developed locale until full content is ready.',
    resources: [],
  },
  'page(s) have content language mismatches': {
    effort: '20 minutes',
    fix: 'Detected content language differs from <html lang>. Either fix the lang attribute or fix the content/translation.',
    example: '<html lang="de">',
    resources: [],
  },
  'Missing html lang attribute': {
    effort: '5 minutes',
    fix: 'Add a lang attribute to <html>. Helps screen readers pronounce correctly and helps search engines target the right locale.',
    example: '<html lang="en">',
    resources: [{ text: 'html lang', url: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/lang' }],
  },
  'Pages missing HTML lang attribute': {
    effort: '5 minutes',
    fix: 'Set <html lang="..."> in the root layout so every page declares its language.',
    example: '<html lang="en">',
    resources: [],
  },

  // ─── Performance: third-party / fonts / DOM ──────────────────────────────
  // Single canonical third-party-payload finding (tier-twin collapsed, report-rules.md §5).
  // Covers both the >warning and >critical bands; the crossed band is in the detail.
  'Large third-party payload': {
    effort: '2-4 hours',
    fix: 'Third-party resources (scripts, embeds, media, fonts) exceed the budget (the detail shows the size and which band it crossed). Audit /third-party-summary in Chrome DevTools: defer non-critical scripts, lazy-load embeds and videos with facades, self-host or compress heavy media, and remove unused vendors.',
    example: '<script src="analytics.js" defer></script>\n<!-- Use lite-youtube-embed instead of full YouTube iframe -->',
    resources: [{ text: 'Optimizing 3rd-Party', url: 'https://web.dev/articles/optimizing-third-party-javascript' }],
  },
  'Heavy advertising scripts': {
    effort: '1-2 hours',
    fix: 'Lazy-load ad SDKs after first paint. Use lightweight ad networks where possible; ads typically dominate CPU/JS budgets.',
    example: 'window.addEventListener("load", () => loadAdScript());',
    resources: [],
  },
  'Many third-party domains used': {
    effort: '1-2 hours',
    fix: 'Each unique third-party origin adds DNS + TLS round-trips. Audit which vendors are necessary and consolidate (e.g. one tag manager instead of many).',
    resources: [],
  },
  'Too many third-party origins': {
    effort: '1 hour',
    fix: 'Reduce the number of distinct third-party origins. Each origin costs DNS lookup + TLS handshake + cookies.',
    resources: [],
  },
  'Too many third-party requests': {
    effort: '1-2 hours',
    fix: 'Audit and reduce third-party requests. Combine where possible, defer where allowed, and remove unused trackers.',
    resources: [],
  },
  'Site connects to unique origins': {
    effort: '1 hour',
    fix: 'Inventory third-party connections; remove duplicates and unused vendors. Add preconnect hints for the most critical origins.',
    example: '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    resources: [],
  },
  'Critical third-party origin lacks preconnect': {
    effort: '5 minutes',
    fix: 'Add <link rel="preconnect"> for the most-used third-party origin to shave 100–300ms off first request to it.',
    example: '<link rel="preconnect" href="https://www.googletagmanager.com" crossorigin>',
    resources: [{ text: 'preconnect', url: 'https://web.dev/articles/preconnect-and-dns-prefetch' }],
  },
  'Most pages lack resource hints': {
    effort: '15 minutes',
    fix: 'Add preconnect/dns-prefetch hints for third-party origins used early in the page (fonts, analytics, CDN).',
    example: '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="dns-prefetch" href="https://www.google-analytics.com">',
    resources: [{ text: 'Resource Hints', url: 'https://web.dev/articles/preconnect-and-dns-prefetch' }],
  },
  'Many pages have render-blocking third-party scripts': {
    effort: '30 minutes',
    fix: 'Add async or defer to non-critical third-party scripts. Critical ones (consent SDKs) load early; everything else can defer.',
    example: '<script src="https://widget.example.com/widget.js" defer></script>',
    resources: [],
  },
  'Render-blocking third-party scripts': {
    effort: '30 minutes',
    fix: 'Defer or async non-critical third-party scripts so they do not block initial render.',
    example: '<script src="..." async></script>',
    resources: [{ text: 'Render-Blocking', url: 'https://web.dev/articles/render-blocking-resources' }],
  },
  'Render-blocking JavaScript in <head>': {
    effort: '20 minutes',
    fix: 'Move non-critical <script> tags out of <head>, add defer/async, or load them at the bottom of <body>. Only essential bootstrap should block render.',
    example: '<script src="/app.js" defer></script>',
    resources: [{ text: 'Render-Blocking', url: 'https://web.dev/articles/render-blocking-resources' }],
  },
  'Most pages have render-blocking JavaScript in head': {
    effort: '30 minutes',
    fix: 'Audit head-level scripts site-wide. Add defer to anything that does not need to block render.',
    resources: [],
  },
  'Render-blocking JavaScript in': {
    effort: '20 minutes',
    fix: 'Add defer or async to render-blocking scripts so they do not stall first paint.',
    example: '<script src="/app.js" defer></script>',
    resources: [],
  },
  'Too many render-blocking resources': {
    effort: '30 minutes',
    fix: 'Reduce render-blocking CSS/JS in <head>. Inline critical CSS, defer the rest, async non-critical JS.',
    resources: [],
  },
  'Some pages have too many render-blocking resources': {
    effort: '30 minutes',
    fix: 'Audit pages with too many blocking resources. Inline critical CSS and defer non-critical assets.',
    resources: [],
  },
  'Too many render-blocking stylesheets': {
    effort: '30 minutes',
    fix: 'Multiple <link rel="stylesheet"> in <head> serialize. Combine into one critical bundle and load secondary styles asynchronously.',
    example: '<link rel="preload" href="non-critical.css" as="style" onload="this.rel=\'stylesheet\'">',
    resources: [],
  },
  'Most pages have multiple blocking stylesheets': {
    effort: '30 minutes',
    fix: 'Consolidate stylesheets at build time. Inline critical CSS and async-load the rest.',
    resources: [],
  },
  'Large render-blocking CSS': {
    effort: '30 minutes',
    fix: 'Split CSS — inline critical (above-the-fold) styles, lazy-load the rest. Tools: Critters, Critical, PurgeCSS.',
    example: 'npx critters --inline path/to/index.html',
    resources: [{ text: 'Critical CSS', url: 'https://web.dev/articles/extract-critical-css' }],
  },
  'Multiple render-blocking resources': {
    effort: '20 minutes',
    fix: 'Combine or defer multiple render-blocking assets. Each blocking resource adds one round-trip before paint.',
    resources: [],
  },
  'High average render-blocking resources': {
    effort: '30 minutes',
    fix: 'On average, pages load too many blocking resources. Refactor head template and use the build pipeline to bundle/inline critical assets.',
    resources: [],
  },
  'No critical CSS implementation detected': {
    effort: '1 hour',
    fix: 'Extract above-the-fold CSS and inline it in <head>; lazy-load the rest. This cuts render-blocking time substantially.',
    example: 'npx critters\n# or: npx critical --inline true',
    resources: [{ text: 'Critical CSS', url: 'https://web.dev/articles/extract-critical-css' }],
  },
  'Large inline CSS': {
    effort: '30 minutes',
    fix: 'Inline CSS exceeds reasonable size (typically >14KB starts blocking the initial TCP window). Move non-critical styles to an external stylesheet.',
    resources: [],
  },
  'Large HTML document': {
    effort: '30 minutes',
    fix: 'HTML payload is too large. Paginate long lists, defer large embeds, remove inline scripts/styles, and consider streaming SSR.',
    resources: [],
  },

  // ─── Performance: fonts ──────────────────────────────────────────────────
  'Excessive web font payload': {
    effort: '1 hour',
    fix: 'Total font payload >300KB. Subset fonts (Latin only), use WOFF2 (best compression), drop weights you do not use, self-host critical fonts.',
    example: 'fonttools subset --flavor=woff2 --unicodes="U+0020-007F" Roboto.ttf',
    resources: [{ text: 'Font Optimization', url: 'https://web.dev/articles/reduce-webfont-size' }],
  },
  'Large web font payload': {
    effort: '30 minutes',
    fix: 'Font payload is significant. Subset to required characters, use WOFF2 only (drop legacy formats), limit to 1-2 weights.',
    resources: [{ text: 'Font Optimization', url: 'https://web.dev/articles/reduce-webfont-size' }],
  },
  'Too many font files loaded': {
    effort: '30 minutes',
    fix: 'Reduce the number of font files. Use one or two weights per family and variable fonts where possible.',
    example: '@font-face { font-family: "Inter"; src: url("/Inter.var.woff2") format("woff2-variations"); font-weight: 100 900; }',
    resources: [{ text: 'Variable Fonts', url: 'https://web.dev/articles/variable-fonts' }],
  },
  'Critical font not preloaded': {
    effort: '5 minutes',
    fix: 'Preload the font used in above-the-fold text to avoid FOIT/FOUT and improve LCP.',
    example: '<link rel="preload" href="/Inter.woff2" as="font" type="font/woff2" crossorigin>',
    resources: [{ text: 'Preload Fonts', url: 'https://web.dev/articles/codelab-preload-web-fonts' }],
  },
  'Font preload missing crossorigin': {
    effort: '2 minutes',
    fix: 'Font <link rel="preload"> requires crossorigin even for same-origin fonts. Without it, the browser fetches the font twice.',
    example: '<link rel="preload" href="/Inter.woff2" as="font" type="font/woff2" crossorigin>',
    resources: [],
  },
  'Missing font-display property': {
    effort: '5 minutes',
    fix: 'Add font-display: swap (or optional) to @font-face rules so text renders with a fallback while the font loads.',
    example: '@font-face { font-family: "Inter"; src: url("/Inter.woff2") format("woff2"); font-display: swap; }',
    resources: [{ text: 'font-display', url: 'https://web.dev/articles/font-display' }],
  },
  'Most pages missing font-display property': {
    effort: '10 minutes',
    fix: 'Add font-display: swap to every @font-face rule. Eliminates invisible-text periods during font loading.',
    example: 'font-display: swap;',
    resources: [],
  },
  'Many different font files used across site': {
    effort: '1 hour',
    fix: 'Consolidate to a small, consistent type system (e.g. one display family + one body family + monospace). Each variant adds bytes and renders flash.',
    resources: [],
  },

  // ─── Performance: critical path / DOM ────────────────────────────────────
  'Excessive DOM size': {
    effort: '1-2 hours',
    fix: 'DOM has too many nodes (>1500). Virtualize long lists, paginate, remove wrapper divs, and avoid hidden-but-rendered offscreen content.',
    example: '// React: use react-window or react-virtual for long lists.',
    resources: [{ text: 'DOM Size', url: 'https://developer.chrome.com/docs/lighthouse/performance/dom-size' }],
  },
  'Deep DOM nesting': {
    effort: '30 minutes',
    fix: 'Flatten deeply-nested markup (>32 levels). Deep nesting slows style calculation and layout.',
    resources: [],
  },
  'Element with too many children': {
    effort: '30 minutes',
    fix: 'A single element has too many direct children (>60). Virtualize, paginate, or restructure.',
    resources: [],
  },

  // ─── Performance: images ─────────────────────────────────────────────────
  'Above-fold images use lazy loading': {
    effort: '10 minutes',
    fix: 'Remove loading="lazy" from above-the-fold images (especially the LCP image). Lazy loading the hero image delays LCP.',
    example: '<img src="/hero.webp" width="1200" height="600" fetchpriority="high">   <!-- no loading="lazy" -->',
    resources: [{ text: 'fetchpriority', url: 'https://web.dev/articles/fetch-priority' }],
  },
  'Lazy loading misused on above-fold images': {
    effort: '10 minutes',
    fix: 'Audit image attributes — only below-the-fold images should be loading="lazy". Above-the-fold should be eagerly loaded (and the LCP image should have fetchpriority="high").',
    resources: [],
  },
  'LCP element below the fold': {
    effort: '30 minutes',
    fix: 'Restructure the page so the largest above-the-fold element is the LCP candidate. If your LCP is below the fold, Lighthouse is measuring something the user does not see first.',
    resources: [{ text: 'Optimize LCP', url: 'https://web.dev/articles/optimize-lcp' }],
  },
  'LCP element below fold on many pages': {
    effort: '1-2 hours',
    fix: 'Site-wide structural issue: LCP candidate is below the fold. Reorganize templates so the largest above-fold element loads earliest.',
    resources: [],
  },
  'LCP images not preloaded across site': {
    effort: '20 minutes',
    fix: 'Add <link rel="preload"> for the LCP image in your shared head template so every page benefits.',
    example: '<link rel="preload" as="image" href="/hero.webp" fetchpriority="high">',
    resources: [{ text: 'Preload LCP', url: 'https://web.dev/articles/optimize-lcp#optimize_when_the_resource_is_discovered' }],
  },
  'LCP image missing fetchpriority="high"': {
    effort: '5 minutes',
    fix: 'Add fetchpriority="high" to the LCP <img> to bump it ahead of other resources in the network queue.',
    example: '<img src="/hero.webp" fetchpriority="high" alt="...">',
    resources: [{ text: 'fetchpriority', url: 'https://web.dev/articles/fetch-priority' }],
  },
  'Large above-fold image payload': {
    effort: '30 minutes',
    fix: 'Compress and resize the hero/above-fold images. Serve responsive sizes via srcset, use AVIF/WebP, and never ship 4K originals.',
    example: '<img srcset="/hero-800.webp 800w, /hero-1600.webp 1600w" sizes="100vw" src="/hero-800.webp">',
    resources: [],
  },
  'Large average above-fold image payload': {
    effort: '1 hour',
    fix: 'Optimize hero images sitewide: compression pipeline, srcset for responsive sizes, modern formats (AVIF/WebP).',
    resources: [],
  },
  'Some pages have excessive total image size': {
    effort: '1 hour',
    fix: 'Total image bytes per page exceed reasonable budget (>2MB). Lazy-load below-the-fold images, serve responsive sizes, drop unused image weights.',
    resources: [],
  },
  'Some pages have many images but none use lazy loading': {
    effort: '15 minutes',
    fix: 'Add loading="lazy" to below-the-fold images. Native lazy-loading saves bandwidth and improves CWV.',
    example: '<img src="..." loading="lazy" width="..." height="...">',
    resources: [{ text: 'Native lazy loading', url: 'https://web.dev/articles/browser-level-image-lazy-loading' }],
  },
  'Pages serve images only as JPG/PNG instead of WebP/AVIF': {
    effort: '1 hour',
    fix: 'Serve modern formats (AVIF, WebP) with JPEG/PNG fallbacks via <picture>. Modern formats are 30-50% smaller.',
    example: '<picture>\n  <source srcset="hero.avif" type="image/avif">\n  <source srcset="hero.webp" type="image/webp">\n  <img src="hero.jpg" alt="...">\n</picture>',
    resources: [],
  },
  'Some images are significantly larger than their display size': {
    effort: '30 minutes',
    fix: 'Resize images to their actual display dimensions. Serving 2000px-wide image at 400px display wastes bandwidth and decode time.',
    resources: [],
  },
  'Some images download larger srcset candidates than they need': {
    effort: '20 minutes',
    fix: 'Tighten the sizes attribute so the browser picks a smaller srcset candidate. Common cause: sizes="100vw" on an element actually rendered at 400px.',
    example: '<img srcset="/img-400.webp 400w, /img-800.webp 800w" sizes="(max-width: 600px) 100vw, 400px">',
    resources: [],
  },
  'Some images load smaller srcset candidates than display target': {
    effort: '20 minutes',
    fix: 'The sizes attribute is too small for the actual rendered size, so the browser picks a low-res candidate. Recalculate sizes per breakpoint.',
    resources: [],
  },
  'Image links without alt text': {
    effort: '15 minutes',
    fix: 'When an <img> is the only content of an <a>, the alt text becomes the link\'s accessible name. Add descriptive alt — empty alt makes the link unreachable for screen readers.',
    example: '<a href="/product"><img src="thumb.jpg" alt="Blue ceramic coffee mug"></a>',
    resources: [],
  },

  // ─── Performance: redirects ──────────────────────────────────────────────
  'Redirect loop detected': {
    effort: '30 minutes',
    fix: 'A redirect chain points back to itself. Audit .htaccess, nginx config, framework redirects, and CDN rules to find the cycle.',
    resources: [],
  },
  'Long redirect chain detected': {
    effort: '20 minutes',
    fix: 'Reduce A→B→C→D chains to a single A→D hop. Each redirect adds a round-trip.',
    resources: [{ text: '301 Redirects', url: 'https://developers.google.com/search/docs/crawling-indexing/301-redirects' }],
  },
  'Pages with long redirect chains': {
    effort: '30 minutes',
    fix: 'Audit pages with multi-hop redirects. Collapse to a single redirect from origin → final destination.',
    resources: [],
  },
  'Multiple redirects detected': {
    effort: '20 minutes',
    fix: 'Page hits more than one redirect before landing. Update internal links to point at the final URL directly.',
    resources: [],
  },
  'Redirect to different domain': {
    effort: '30 minutes',
    fix: 'Cross-domain redirect — verify it is intentional (e.g. brand migration). For user-facing pages, ensure the destination is HTTPS and the canonical/sitemap reflects the new domain.',
    resources: [],
  },
  'High number of redirects wasting crawl budget': {
    effort: '1 hour',
    fix: 'Too many internal redirects burn crawl budget. Update internal links to point at canonical URLs directly.',
    resources: [],
  },
  'Links pointing to redirects': {
    effort: '20 minutes',
    fix: 'Internal links targeting redirect URLs waste a hop. Update href values to point to the final destination.',
    resources: [],
  },
  'Temporary redirect used instead of permanent': {
    effort: '10 minutes',
    fix: 'Use 301 (permanent) for moved pages — Google passes ranking signals more decisively. Reserve 302/307 for genuinely temporary cases.',
    example: 'nginx: return 301 https://new-url;\nexpress: res.redirect(301, "/new-url");',
    resources: [],
  },
  'More temporary redirects than permanent': {
    effort: '30 minutes',
    fix: 'Audit redirect rules — most should be 301. 302s prevent search engines from consolidating signals on the new URL.',
    resources: [],
  },
  'High percentage of pages have redirects': {
    effort: '1 hour',
    fix: 'Many pages redirect somewhere else. Update internal links/sitemap/canonicals to point at the final URLs.',
    resources: [],
  },
  'HTTP→HTTPS and www redirects not combined': {
    effort: '15 minutes',
    fix: 'Combine HTTP→HTTPS and non-www→www (or vice versa) into a single redirect hop, not two sequential ones.',
    example: 'nginx:\nif ($host = "example.com") { return 301 https://www.example.com$request_uri; }',
    resources: [],
  },

  // ─── Network / connection ────────────────────────────────────────────────
  'pages have slow server response': {
    effort: '1-2 hours',
    fix: 'TTFB is slow on these pages. Add caching (CDN edge, app cache, DB query cache), profile slow handlers, or upgrade hosting.',
    resources: [{ text: 'TTFB', url: 'https://web.dev/articles/ttfb' }],
  },
  'No DNS records found for domain': {
    effort: '30 minutes',
    fix: 'DNS lookup returned no records. Verify A/AAAA/CNAME records at your DNS provider. Until DNS resolves, the site is unreachable.',
    resources: [],
  },
  'Only one nameserver configured': {
    effort: '15 minutes',
    fix: 'Configure at least two geographically diverse nameservers. Single-NS setups are an outage risk.',
    resources: [],
  },
  'Slow TLS negotiation': {
    effort: '30 minutes',
    fix: 'Enable TLS 1.3 (faster handshake), OCSP stapling, and session resumption. Use a CDN to terminate TLS closer to users.',
    example: 'nginx: ssl_session_cache shared:SSL:10m;\nssl_session_tickets on;\nssl_stapling on;',
    resources: [{ text: 'Mozilla SSL Config', url: 'https://ssl-config.mozilla.org/' }],
  },
  'HTTP/1.1 connection limitations affecting performance': {
    effort: '1 hour',
    fix: 'Upgrade origin/CDN to HTTP/2 or HTTP/3. HTTP/1.1 limits concurrent requests per origin to ~6 and serializes them.',
    resources: [{ text: 'HTTP/2', url: 'https://web.dev/articles/performance-http2' }],
  },
  'Site using HTTP/1.1': {
    effort: '1 hour',
    fix: 'Enable HTTP/2 (or HTTP/3) on your server or CDN. Most CDNs offer this with a single config flag.',
    resources: [],
  },
  'Majority of site using HTTP/1.1': {
    effort: '30 minutes',
    fix: 'Most assets still served over HTTP/1.1. Enable HTTP/2 on your origin or CDN config.',
    resources: [],
  },
  'HTML not compressed': {
    effort: '15 minutes',
    fix: 'Enable gzip or brotli compression for text responses (HTML/JS/CSS/JSON). Brotli is typically 15-25% smaller than gzip.',
    example: 'nginx:\ngzip on;\nbrotli on;\nbrotli_types text/html text/css application/javascript;',
    resources: [{ text: 'Compression', url: 'https://web.dev/articles/codelab-text-compression' }],
  },
  'Large resources not compressed': {
    effort: '15 minutes',
    fix: 'Specific large assets are served uncompressed. Verify Content-Encoding header is set on all text responses.',
    resources: [],
  },
  'Inconsistent compression across pages': {
    effort: '20 minutes',
    fix: 'Some pages compress, others do not. Likely a server config issue — check vhost/route-specific overrides.',
    resources: [],
  },
  'Preload missing "as" attribute': {
    effort: '5 minutes',
    fix: 'rel="preload" requires an "as" attribute (style/script/image/font/etc). Without it, browsers may double-fetch or ignore the hint.',
    example: '<link rel="preload" href="/app.js" as="script">',
    resources: [],
  },

  // ─── Performance: SPA / JS rendering ─────────────────────────────────────
  'Site heavily relies on JavaScript rendering': {
    effort: '4-8 hours',
    fix: 'Significant content is rendered client-side. Search engines may not see it consistently. Add SSR or static prerendering for SEO-critical pages.',
    resources: [{ text: 'SEO & JavaScript', url: 'https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics' }],
  },
  'Significant content rendered by JavaScript': {
    effort: '2-4 hours',
    fix: 'Move SEO-critical content (title, meta, headings, body) into server-rendered HTML. Hydration can layer interactivity afterward.',
    resources: [],
  },
  'Page heavily relies on JavaScript for content': {
    effort: '2-4 hours',
    fix: 'This page renders most content via JS. Switch to SSR/SSG for the route or prerender at build time.',
    resources: [],
  },
  'Single Page Application without SSR detected': {
    effort: '4-8 hours',
    fix: 'SPA without SSR. Add SSR (Next/Nuxt/Astro/Remix) or static prerendering for indexable routes.',
    resources: [],
  },
  'Slow JavaScript rendering': {
    effort: '2 hours',
    fix: 'Reduce main-thread work: code-split, defer non-critical JS, lazy-hydrate, and avoid blocking long tasks.',
    resources: [{ text: 'Reduce JavaScript', url: 'https://web.dev/articles/reduce-javascript-payloads-with-code-splitting' }],
  },
  'Page titles rendered by JavaScript': {
    effort: '1 hour',
    fix: 'Render <title> server-side. Bots may use the SSR title; client-injected titles are unreliable for SERP snippets.',
    resources: [],
  },
  'Title tag rendered by JavaScript': {
    effort: '30 minutes',
    fix: 'Set <title> in the SSR/SSG output, not via document.title in client code.',
    resources: [],
  },
  'Meta description rendered by JavaScript': {
    effort: '30 minutes',
    fix: 'Render meta description in the initial HTML response. Client-set meta tags are inconsistently indexed.',
    resources: [],
  },
  'Main content rendered by JavaScript': {
    effort: '2-4 hours',
    fix: 'Move the page\'s main content into the SSR output. Hydrate for interactivity after.',
    resources: [],
  },
  'H1 heading rendered by JavaScript': {
    effort: '20 minutes',
    fix: 'Render H1 in the initial HTML. JS-rendered H1s are flagged less reliably for SEO/accessibility.',
    resources: [],
  },
  'Internal links rendered by JavaScript': {
    effort: '1 hour',
    fix: 'Render internal navigation as real <a href> links in the HTML so crawlers can follow them. Avoid div+onclick patterns.',
    resources: [],
  },
  'URL uses hash-based routing': {
    effort: '2-4 hours',
    fix: 'Hash-based URLs (/#/page) are not indexable. Switch the router to history-mode (pushState) with server fallback.',
    example: '// React Router: createBrowserRouter instead of createHashRouter.',
    resources: [{ text: 'history.pushState', url: 'https://developer.mozilla.org/en-US/docs/Web/API/History/pushState' }],
  },
  'Recurring JavaScript errors detected': {
    effort: '1 hour',
    fix: 'Fix the most frequent JS exceptions. Use a monitoring tool (Sentry, Rollbar) to triage.',
    resources: [],
  },
  'pages have JavaScript errors': {
    effort: '1 hour',
    fix: 'JS errors break interactivity and may hide content from crawlers. Resolve top exceptions.',
    resources: [],
  },
  'pages have critical JavaScript errors': {
    effort: '2 hours',
    fix: 'Critical JS errors prevent rendering or core flows. Prioritize and fix.',
    resources: [],
  },

  // ─── Performance: above-fold / coverage ──────────────────────────────────
  'No significant content above the fold': {
    effort: '30 minutes',
    fix: 'Above-the-fold area is mostly empty (loaders, banners, blank space). Restructure so meaningful content is visible immediately.',
    resources: [],
  },
  'Site-wide: % of JavaScript is unused on average': {
    effort: '2-4 hours',
    fix: 'Significant JavaScript shipped but unused per page. Code-split routes, defer non-critical modules, and remove unused dependencies.',
    example: '// Dynamic import:\nconst Chart = lazy(() => import("./Chart"));',
    resources: [{ text: 'Code Splitting', url: 'https://web.dev/articles/reduce-javascript-payloads-with-code-splitting' }],
  },
  'Site-wide: % of CSS is unused on average': {
    effort: '1 hour',
    fix: 'Most CSS bytes ship unused. Run PurgeCSS at build, scope styles tighter, drop unused utility frameworks.',
    example: 'npx purgecss --css style.css --content "**/*.html"',
    resources: [],
  },
  'script(s) consistently have high unused code': {
    effort: '1-2 hours',
    fix: 'Specific scripts ship a lot of dead code. Split, tree-shake, or replace with a smaller alternative.',
    resources: [],
  },

  // ─── Performance: PWA / manifest ─────────────────────────────────────────
  'PWA requires HTTPS': {
    effort: '1 hour',
    fix: 'PWAs (Service Worker + install prompt) require HTTPS. Migrate the site to HTTPS first.',
    resources: [],
  },
  'Web manifest not parsed': {
    effort: '20 minutes',
    fix: 'manifest.json is invalid JSON or the file fails to load. Validate at manifest-validator.appspot.com and fix syntax.',
    resources: [{ text: 'Web App Manifest', url: 'https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest' }],
  },
  'Invalid manifest JSON': {
    effort: '15 minutes',
    fix: 'Fix the JSON syntax in manifest.json. Validate with jsonlint or chrome://lighthouse.',
    resources: [],
  },
  'Manifest missing required fields': {
    effort: '15 minutes',
    fix: 'Add required fields: name, short_name, start_url, display, icons.',
    example: '{ "name": "...", "short_name": "...", "start_url": "/", "display": "standalone", "icons": [...] }',
    resources: [{ text: 'Manifest Fields', url: 'https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest' }],
  },
  'Manifest missing required icon sizes': {
    effort: '20 minutes',
    fix: 'Add at least 192×192 and 512×512 PNG icons in the manifest icons array.',
    example: '{ "icons": [{ "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" }, { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }] }',
    resources: [],
  },
  'Manifest has no icons': {
    effort: '20 minutes',
    fix: 'Add icons[] to manifest.json with at least 192px and 512px PNG entries. Without icons the PWA install prompt is suppressed.',
    resources: [],
  },
  'start_url outside scope': {
    effort: '5 minutes',
    fix: 'manifest start_url must be within the scope. Either widen scope or move start_url under the existing scope.',
    resources: [],
  },

  // ─── SEO: headings / content ─────────────────────────────────────────────
  'Page has very thin content': {
    effort: '1-2 hours',
    fix: 'Add substantive, unique content (target 300+ words). Thin pages dilute crawl budget and rarely rank.',
    resources: [{ text: 'Thin Content', url: 'https://developers.google.com/search/docs/essentials/spam-policies' }],
  },
  'Page has low content': {
    effort: '1 hour',
    fix: 'Expand page content with useful detail, FAQs, or consolidate into a richer page.',
    resources: [],
  },
  'pages have very thin content': {
    effort: '2-4 hours',
    fix: 'Many pages are thin. Either expand them or consolidate into fewer, deeper pages and 301 redirect the rest.',
    resources: [],
  },
  'pages have insufficient content': {
    effort: '2 hours',
    fix: 'Insufficient content for ranking intent. Expand with relevant detail or remove.',
    resources: [],
  },
  'have thin content': {
    effort: '1-2 hours',
    fix: 'Audit thin pages and consolidate or expand them.',
    resources: [],
  },
  'Spelling errors detected': {
    effort: '30 minutes',
    fix: 'Proofread the flagged copy and correct the misspellings in the source content (CMS entry or component text). Add a spell-check step to your editorial/PR workflow to catch them before publish.',
    resources: [
      { text: 'cspell', url: 'https://cspell.org/' },
    ],
  },
  'pages have near-duplicate content': {
    effort: '2-4 hours',
    fix: 'Pages with high text overlap. Either canonical to the master version, merge, or differentiate the content.',
    resources: [{ text: 'Duplicate Content', url: 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls' }],
  },
  'pages have very similar content': {
    effort: '2 hours',
    fix: 'Differentiate or canonicalize. Templated pages with mostly-shared content rarely rank.',
    resources: [],
  },
  'Content has a date in the future': {
    effort: '5 minutes',
    fix: 'A page shows a publish/modified date in the future. Likely a CMS typo or timezone issue. Fix the source date.',
    resources: [],
  },
  'Many pages have stale content': {
    effort: '2-4 hours',
    fix: 'Audit pages with old datePublished/Modified. Update content, refresh dates, or add a "last reviewed" note for evergreen pages.',
    resources: [],
  },
  'Multiple pages with similar H1 keyword': {
    effort: '1 hour',
    fix: 'Multiple pages targeting the same H1 keyword compete (keyword cannibalization). Consolidate or differentiate intent.',
    resources: [],
  },
  'Near-duplicate page titles detected': {
    effort: '30 minutes',
    fix: 'Some titles differ only by a few words. Make titles uniquely descriptive of each page\'s topic.',
    resources: [],
  },
  'Duplicate page titles found': {
    effort: '30 minutes',
    fix: 'Multiple pages share identical titles. Make each unique.',
    resources: [],
  },
  'Duplicate titles detected': {
    effort: '30 minutes',
    fix: 'Audit duplicate titles and rewrite each to be unique.',
    resources: [],
  },
  'Duplicate meta descriptions found': {
    effort: '30 minutes',
    fix: 'Write unique descriptions per page. Identical descriptions waste an SEO signal.',
    resources: [],
  },
  'Parameterized URLs share a title': {
    effort: '30 minutes',
    fix: 'These URLs are the same page viewed through different query parameters (filters/sorts/pagination), so they correctly share a title — do not retitle them. Add a rel="canonical" on each parameterized variant pointing to the clean base URL (or noindex the filtered views, or configure parameter handling in Search Console) so the duplicates consolidate to one indexable page. Only give a filtered view its own title + self-canonical if it is genuinely meant to rank on its own.',
    resources: [],
  },
  'Parameterized URLs share a description': {
    effort: '30 minutes',
    fix: 'These URLs are the same page with different query parameters, so the shared description is expected — do not rewrite per variant. Canonicalize each parameterized URL to the clean base URL (or noindex the filtered views) so the duplicates consolidate, rather than crafting a unique description for every filter combination.',
    resources: [],
  },
  'Some pages have incorrect h tags structure': {
    effort: '15 minutes',
    fix: 'Headings skip levels (e.g. H1→H3). Use sequential H1→H2→H3 nesting so screen readers and crawlers can parse structure.',
    example: '<h1>Page</h1>\n<h2>Section</h2>\n<h3>Subsection</h3>',
    resources: [],
  },
  'Many topics with thin coverage': {
    effort: '2-4 hours',
    fix: 'Many topics covered only superficially. Either deepen the strongest topics or remove the weakest.',
    resources: [],
  },
  'High-opportunity content gaps identified': {
    effort: '4-8 hours',
    fix: 'High-traffic queries with no matching page on your site. Plan content for the top gaps.',
    resources: [],
  },

  // ─── SEO: meta refresh, deprecated, charset ──────────────────────────────
  'Page uses meta refresh redirect': {
    effort: '10 minutes',
    fix: 'Replace <meta http-equiv="refresh"> with a server-side 301 redirect. Meta refresh confuses crawlers and hurts UX.',
    example: 'nginx: return 301 /new-page;',
    resources: [],
  },
  'pages use meta refresh redirects': {
    effort: '20 minutes',
    fix: 'Remove all <meta http-equiv="refresh"> tags and replace with proper 301 redirects.',
    resources: [],
  },
  'Page uses delayed meta refresh': {
    effort: '10 minutes',
    fix: 'Delayed meta-refresh is worse than instant. Replace with a 301 redirect on the server.',
    resources: [],
  },
  'Deprecated / elements detected': {
    effort: '20 minutes',
    fix: 'Replace deprecated HTML elements (<center>, <font>, <marquee>, etc.) with modern equivalents and CSS.',
    resources: [],
  },
  'Deprecated element used': {
    effort: '10 minutes',
    fix: 'A deprecated HTML element appears in markup. Replace with the modern equivalent.',
    resources: [],
  },
  'Missing element': {
    effort: '15 minutes',
    fix: 'A required HTML element is missing (often <meta name="viewport">, <link rel="canonical">, or <title>). Add it to the page template.',
    resources: [],
  },
  'Missing declaration': {
    effort: '5 minutes',
    fix: 'A required HTML declaration is missing (e.g. <!DOCTYPE html> at the top). Add it.',
    example: '<!DOCTYPE html>\n<html lang="en">',
    resources: [],
  },
  'Missing character encoding declaration': {
    effort: '5 minutes',
    fix: 'Add <meta charset="utf-8"> as the first child of <head>. Required for correct rendering of non-ASCII content.',
    example: '<head>\n  <meta charset="utf-8">',
    resources: [],
  },
  'Pages using non-UTF-8 charset': {
    effort: '30 minutes',
    fix: 'Migrate pages to UTF-8. Modern web standards assume UTF-8 and other charsets cause rendering bugs.',
    resources: [],
  },

  // ─── SEO: URL architecture / pagination ──────────────────────────────────
  'URL contains tracking parameters': {
    effort: '15 minutes',
    fix: 'Canonical URL should not include tracking params (utm_*, gclid, fbclid). Add rel="canonical" pointing to the clean URL.',
    example: '<link rel="canonical" href="https://example.com/page">  <!-- without ?utm_source=... -->',
    resources: [],
  },
  'URL contains multiple consecutive slashes': {
    effort: '10 minutes',
    fix: 'URLs with // duplicate hops fragment crawl signals. Normalize at the server (collapse repeated slashes).',
    example: 'nginx: merge_slashes on;',
    resources: [],
  },
  'Inconsistent trailing slash usage across site': {
    effort: '30 minutes',
    fix: 'Pick one style (trailing slash or not) and enforce site-wide via 301 redirect. Update internal links to match.',
    resources: [],
  },
  'www/non-www inconsistency detected': {
    effort: '15 minutes',
    fix: 'Decide canonical host (www vs apex) and 301-redirect the other. Update canonicals, sitemap, hreflang.',
    example: 'nginx: server_name example.com; return 301 https://www.example.com$request_uri;',
    resources: [],
  },
  'Paginated page is noindexed': {
    effort: '15 minutes',
    fix: 'Paginated pages should usually be indexable (rel=next/prev is deprecated; Google now treats them as separate pages). Remove noindex unless you have a reason.',
    resources: [],
  },
  'Paginated page canonicals to different URL': {
    effort: '15 minutes',
    fix: 'Paginated pages should self-canonical (page 2 canonical to page 2), not all point to page 1. Otherwise page 2+ disappears from the index.',
    resources: [],
  },
  'paginated pages have incorrect canonicals': {
    effort: '30 minutes',
    fix: 'Audit paginated routes — each /page/N should have a self-referential canonical, not point to /page/1.',
    resources: [],
  },
  'pages use infinite scroll without pagination fallback': {
    effort: '2-4 hours',
    fix: 'Infinite scroll without crawlable pagination hides content from search engines. Provide /page/2/, /page/3/ links as a fallback.',
    resources: [{ text: 'Infinite scroll SEO', url: 'https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading' }],
  },
  'Infinite scroll without pagination fallback': {
    effort: '2 hours',
    fix: 'Add real <a href="/page/N"> pagination so crawlers can reach paginated content.',
    resources: [],
  },
  '"Load More" pattern without pagination links': {
    effort: '2 hours',
    fix: 'Add crawlable pagination as a fallback for the "Load More" button. Use progressive enhancement: real links + JS overlay.',
    resources: [],
  },
  'API/technical pages may be indexed': {
    effort: '20 minutes',
    fix: 'Block API/admin routes from indexing via robots.txt or X-Robots-Tag: noindex.',
    example: 'X-Robots-Tag: noindex',
    resources: [],
  },
  'Search pages may cause duplicate content': {
    effort: '15 minutes',
    fix: 'Internal search results pages typically should not be indexed. Add noindex or block in robots.txt.',
    example: '<meta name="robots" content="noindex">  <!-- on /search?q=... -->',
    resources: [],
  },

  // ─── SEO: indexability / canonical edges ─────────────────────────────────
  'High percentage of generic anchor text': {
    effort: '1-2 hours',
    fix: 'Replace "click here", "read more", "learn more" with descriptive anchor text that includes the target page\'s topic.',
    example: '<a href="/pricing">View our pricing</a>   <!-- not "Click here" -->',
    resources: [],
  },
  'Anchor text over-optimization detected': {
    effort: '1 hour',
    fix: 'Too many internal links use exact-match keyword anchors — looks unnatural. Vary anchor text naturally.',
    resources: [],
  },
  'Potential anchor text over-optimization': {
    effort: '30 minutes',
    fix: 'Some anchor texts are over-optimized for keywords. Mix in branded and descriptive variations.',
    resources: [],
  },
  'Excessive use of generic anchor text site-wide': {
    effort: '1-2 hours',
    fix: 'Audit shared components (footer, related-posts) for repeated generic links. Replace with descriptive text.',
    resources: [],
  },
  'Too many generic anchor texts': {
    effort: '1 hour',
    fix: 'Too many links lead with "Read more"/"Click here". Rewrite to describe the destination.',
    resources: [],
  },
  'Empty anchor text': {
    effort: '15 minutes',
    fix: 'Links without anchor text are useless to crawlers and screen readers. Add visible text or an aria-label.',
    example: '<a href="/cart" aria-label="Shopping cart"><svg>...</svg></a>',
    resources: [],
  },
  'Links with empty anchor text': {
    effort: '15 minutes',
    fix: 'Add accessible names to icon-only links (visible text or aria-label).',
    resources: [],
  },
  'Many links with empty anchor text': {
    effort: '30 minutes',
    fix: 'Many links have no anchor text. Audit icon-only and image-only links and add aria-label or visible text.',
    resources: [],
  },
  'External link opens in new tab without noopener': {
    effort: '15 minutes',
    fix: 'target="_blank" links should set rel="noopener noreferrer" to prevent tabnabbing.',
    example: '<a href="https://external.com" target="_blank" rel="noopener noreferrer">External</a>',
    resources: [{ text: 'noopener', url: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/noopener' }],
  },
  'Internal links using nofollow attribute': {
    effort: '15 minutes',
    fix: 'Remove rel="nofollow" from internal links. nofollow on internal links blocks PageRank flow needlessly.',
    resources: [],
  },
  'Links to non-indexable pages': {
    effort: '30 minutes',
    fix: 'Internal links point to noindex/blocked pages. Either make those pages indexable, or remove the links.',
    resources: [],
  },
  'Suspicious external links detected': {
    effort: '30 minutes',
    fix: 'External links to potentially spammy or low-quality domains. Add rel="nofollow" or remove.',
    resources: [],
  },
  'Affiliate link without sponsored/nofollow': {
    effort: '10 minutes',
    fix: 'Mark affiliate links with rel="sponsored" (or rel="nofollow"). Required by Google\'s policies.',
    example: '<a href="https://partner.com/?aff=123" rel="sponsored">Buy</a>',
    resources: [{ text: 'rel="sponsored"', url: 'https://developers.google.com/search/docs/essentials/spam-policies#affiliate-content' }],
  },
  'Affiliate links may need disclosure': {
    effort: '15 minutes',
    fix: 'Disclose affiliate relationships on the page. Required by FTC in the US and similar bodies elsewhere.',
    resources: [],
  },

  // ─── SEO: site-wide patterns / link structure ────────────────────────────
  'Broken internal links': {
    effort: '1 hour',
    fix: 'Audit internal 4xx links. Update href to current URL or remove.',
    resources: [],
  },
  'Site has broken internal links': {
    effort: '1-2 hours',
    fix: 'Site-wide broken internal links. Run a crawl tool, fix the highest-frequency dead links first.',
    resources: [],
  },
  'Broken external links': {
    effort: '1 hour',
    fix: 'External links returning 4xx/5xx. Update to current URLs (Wayback Machine for dead pages) or remove.',
    resources: [],
  },
  'Broken external links across site': {
    effort: '1-2 hours',
    fix: 'Many external links broken site-wide. Prioritize fixing high-traffic pages first.',
    resources: [],
  },
  'broken external link(s) verified': {
    effort: '1 hour',
    fix: 'Verified broken external links. Update or remove.',
    resources: [],
  },
  'broken outbound link(s) found across the site': {
    effort: '1 hour',
    fix: 'Fix or replace broken outbound links — they damage user trust and crawl signal.',
    resources: [],
  },
  'Page has broken outbound link(s)': {
    effort: '15 minutes',
    fix: 'Fix or remove broken external links on this page.',
    resources: [],
  },
  'orphan pages detected (no internal links pointing to them)': {
    effort: '30 minutes',
    fix: 'Orphan pages are not reachable from internal navigation. Either link to them from related pages or remove them.',
    resources: [],
  },
  'pages are unreachable from homepage via internal links': {
    effort: '1 hour',
    fix: 'Pages buried beyond crawl depth limits. Surface them in main navigation, breadcrumbs, or related links.',
    resources: [],
  },
  'pages have very low internal link equity': {
    effort: '1-2 hours',
    fix: 'Pages with very few inbound internal links rank poorly. Add contextual links from authoritative pages.',
    resources: [],
  },
  'Significant internal linking opportunities': {
    effort: '2-4 hours',
    fix: 'Identified high-impact internal linking opportunities — connect related content to boost discoverability and PageRank flow.',
    resources: [],
  },
  'High-impact linking opportunities available': {
    effort: '2 hours',
    fix: 'Add internal links from high-authority pages to under-linked targets. Pick anchor text descriptive of the destination.',
    resources: [],
  },
  'dead-end pages have no outgoing internal links': {
    effort: '1 hour',
    fix: 'Pages with no outgoing internal links trap PageRank. Add contextual links to related content.',
    resources: [],
  },
  'page(s) have more than links': {
    effort: '1 hour',
    fix: 'Pages with excessive link count dilute internal PageRank per link. Trim navigation/footer to essentials.',
    resources: [],
  },
  'Significant crawl budget waste detected': {
    effort: '1-2 hours',
    fix: 'Crawlers spend significant budget on non-indexable URLs. Audit redirects, faceted URLs, and parameter URLs; block what should not be crawled.',
    resources: [{ text: 'Crawl Budget', url: 'https://developers.google.com/search/docs/crawling-indexing/large-site-managing-crawl-budget' }],
  },
  'Broken "next" pagination wastes crawl budget': {
    effort: '1-2 hours',
    fix: 'A "next" link stays clickable past the last real page, advancing into empty, duplicate, or soft-404 listings forever. Stop rendering the "next" control on the final page of results (compute the real last page from total item count), and return a genuine 404 for out-of-range page numbers so crawlers stop following the series.',
    resources: [{ text: 'Crawl Budget', url: 'https://developers.google.com/search/docs/crawling-indexing/large-site-managing-crawl-budget' }],
  },

  // ─── SEO: technical / response headers ───────────────────────────────────
  'soft 404 pages detected': {
    effort: '1 hour',
    fix: 'Pages return 200 OK but display "not found" content. Return a proper 404 status, or redirect to a relevant alternative.',
    resources: [{ text: 'Soft 404s', url: 'https://developers.google.com/search/docs/crawling-indexing/http-network-errors#soft-404-errors' }],
  },

  // ─── SEO: structured data ────────────────────────────────────────────────
  'FAQPage missing mainEntity array': {
    effort: '10 minutes',
    fix: 'FAQPage schema requires a mainEntity array of Question/Answer pairs.',
    example: '{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"...","acceptedAnswer":{"@type":"Answer","text":"..."}}]}',
    resources: [{ text: 'FAQPage', url: 'https://developers.google.com/search/docs/appearance/structured-data/faqpage' }],
  },
  'FAQPage has no questions': {
    effort: '15 minutes',
    fix: 'Populate the FAQPage mainEntity with actual Question/Answer pairs from the visible content.',
    resources: [],
  },
  'FAQ Question missing name (question text)': {
    effort: '5 minutes',
    fix: 'Each Question must have a "name" with the question text.',
    example: '{"@type":"Question","name":"How do I reset my password?","acceptedAnswer":{...}}',
    resources: [],
  },
  'FAQ Question missing acceptedAnswer': {
    effort: '5 minutes',
    fix: 'Each Question must have an "acceptedAnswer" with the answer text.',
    resources: [],
  },
  'FAQ Question answer missing text': {
    effort: '5 minutes',
    fix: 'The acceptedAnswer requires a "text" property with the answer body.',
    resources: [],
  },
  'FAQ item is not type Question': {
    effort: '5 minutes',
    fix: 'Each item in mainEntity must be @type:"Question".',
    resources: [],
  },
  'HowTo missing steps': {
    effort: '15 minutes',
    fix: 'HowTo schema needs a "step" array with HowToStep items.',
    example: '{"@type":"HowTo","step":[{"@type":"HowToStep","name":"...","text":"..."}]}',
    resources: [{ text: 'HowTo', url: 'https://developers.google.com/search/docs/appearance/structured-data/how-to' }],
  },
  'HowTo missing name': {
    effort: '5 minutes',
    fix: 'Add a "name" property describing the task.',
    resources: [],
  },
  'HowTo step missing content': {
    effort: '5 minutes',
    fix: 'Each HowToStep needs "name" and "text" describing the step.',
    resources: [],
  },
  'BreadcrumbList missing itemListElement': {
    effort: '10 minutes',
    fix: 'BreadcrumbList requires an itemListElement array with ListItem entries.',
    example: '{"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://example.com/"}]}',
    resources: [{ text: 'BreadcrumbList', url: 'https://developers.google.com/search/docs/appearance/structured-data/breadcrumb' }],
  },
  'Breadcrumb item missing name': {
    effort: '5 minutes',
    fix: 'Each breadcrumb ListItem needs a "name".',
    resources: [],
  },
  'Breadcrumb item missing position': {
    effort: '5 minutes',
    fix: 'Each breadcrumb ListItem needs an integer "position" starting from 1.',
    resources: [],
  },
  'Product schema missing offers/pricing information': {
    effort: '15 minutes',
    fix: 'Product schema should include offers with price/priceCurrency for rich results.',
    example: '{"@type":"Product","offers":{"@type":"Offer","price":"19.99","priceCurrency":"USD","availability":"https://schema.org/InStock"}}',
    resources: [{ text: 'Product', url: 'https://developers.google.com/search/docs/appearance/structured-data/product' }],
  },
  'Product offer missing price': {
    effort: '5 minutes',
    fix: 'Add price + priceCurrency to the offer.',
    resources: [],
  },
  'Duplicate Product schema with same name': {
    effort: '15 minutes',
    fix: 'Multiple identical Product schemas — keep only one per product, give each variant its own SKU/URL.',
    resources: [],
  },
  'Duplicate Article schema with same headline': {
    effort: '15 minutes',
    fix: 'Identical Article schemas across pages indicate duplicated content or copy/paste error in schema generation.',
    resources: [],
  },
  'Review missing author': {
    effort: '5 minutes',
    fix: 'Review schema requires an "author" property (Person or Organization).',
    resources: [],
  },
  'Review missing reviewRating': {
    effort: '5 minutes',
    fix: 'Review schema needs a reviewRating with ratingValue (and bestRating/worstRating if not 5/1).',
    example: '"reviewRating":{"@type":"Rating","ratingValue":"4.5","bestRating":"5","worstRating":"1"}',
    resources: [],
  },
  'Invalid rating value': {
    effort: '5 minutes',
    fix: 'Rating value must be a number between worstRating and bestRating.',
    resources: [],
  },
  'Event has invalid startDate format': {
    effort: '5 minutes',
    fix: 'Event startDate must be ISO 8601 (YYYY-MM-DDTHH:mm:ss±HH:mm).',
    example: '"startDate":"2026-06-01T18:00:00+02:00"',
    resources: [],
  },
  'LocalBusiness address incomplete': {
    effort: '10 minutes',
    fix: 'LocalBusiness needs PostalAddress with streetAddress, addressLocality, postalCode, addressCountry.',
    resources: [],
  },
  'Organization missing name': {
    effort: '5 minutes',
    fix: 'Organization schema requires "name".',
    resources: [],
  },
  'No Organization schema found': {
    effort: '15 minutes',
    fix: 'Add an Organization schema on the homepage/about page with name, url, logo, sameAs.',
    example: '{"@type":"Organization","name":"...","url":"...","logo":"...","sameAs":["https://twitter.com/..."]}',
    resources: [{ text: 'Organization', url: 'https://developers.google.com/search/docs/appearance/structured-data/organization' }],
  },
  'Inconsistent Organization schema across pages': {
    effort: '30 minutes',
    fix: 'Organization data differs across pages (name, logo, sameAs). Centralize in a shared layout component.',
    resources: [],
  },
  'Invalid VideoObject schema': {
    effort: '15 minutes',
    fix: 'Fix VideoObject schema — required fields: name, description, thumbnailUrl, uploadDate.',
    example: '{"@type":"VideoObject","name":"...","thumbnailUrl":"...","uploadDate":"2025-..."}',
    resources: [{ text: 'VideoObject', url: 'https://developers.google.com/search/docs/appearance/structured-data/video' }],
  },
  'VideoObject missing video URL': {
    effort: '5 minutes',
    fix: 'Add contentUrl or embedUrl to the VideoObject.',
    resources: [],
  },
  'Video content without VideoObject schema': {
    effort: '20 minutes',
    fix: 'Pages with video should declare VideoObject schema for richer SERP appearance.',
    resources: [],
  },
  'Most video pages lack VideoObject schema': {
    effort: '1 hour',
    fix: 'Add VideoObject schema across video pages at template level.',
    resources: [],
  },
  'Low structured data coverage': {
    effort: '2-4 hours',
    fix: 'Few pages have structured data. Add Article/Product/FAQ schema based on content type.',
    resources: [{ text: 'Structured Data', url: 'https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data' }],
  },
  'missing required field': {
    effort: '10 minutes',
    fix: 'Schema is missing a required field for its type. Validate at the Rich Results Test and add the field.',
    resources: [{ text: 'Rich Results Test', url: 'https://search.google.com/test/rich-results' }],
  },
  // Aliased schema-type-specific variants — each falls through the prefix
  // fallback but is registered explicitly for direct match.
  'Article missing required field': {
    effort: '10 minutes',
    fix: 'Add the missing required field to the Article schema (headline, author, datePublished, image).',
    resources: [{ text: 'Article schema', url: 'https://developers.google.com/search/docs/appearance/structured-data/article' }],
  },
  'Product missing required field': {
    effort: '10 minutes',
    fix: 'Add the missing required field to the Product schema (name, image, offers).',
    resources: [{ text: 'Product schema', url: 'https://developers.google.com/search/docs/appearance/structured-data/product' }],
  },
  'LocalBusiness missing required field': {
    effort: '10 minutes',
    fix: 'Add the missing required field to the LocalBusiness schema (name, address, telephone).',
    resources: [{ text: 'LocalBusiness schema', url: 'https://developers.google.com/search/docs/appearance/structured-data/local-business' }],
  },
  'Person missing required field': {
    effort: '5 minutes',
    fix: 'Add the missing required field to the Person schema (name).',
    resources: [],
  },
  'Event missing required field': {
    effort: '10 minutes',
    fix: 'Add the missing required field to the Event schema (name, startDate, location).',
    resources: [{ text: 'Event schema', url: 'https://developers.google.com/search/docs/appearance/structured-data/event' }],
  },
  'Recipe missing required field': {
    effort: '10 minutes',
    fix: 'Add the missing required field to the Recipe schema (name, image, recipeIngredient, recipeInstructions).',
    resources: [{ text: 'Recipe schema', url: 'https://developers.google.com/search/docs/appearance/structured-data/recipe' }],
  },
  'VideoObject missing required field': {
    effort: '10 minutes',
    fix: 'Add the missing required field to the VideoObject schema (name, thumbnailUrl, uploadDate, contentUrl or embedUrl).',
    resources: [{ text: 'VideoObject schema', url: 'https://developers.google.com/search/docs/appearance/structured-data/video' }],
  },

  // ─── Social / E-E-A-T / Trust ────────────────────────────────────────────
  'Pages missing social media tags': {
    effort: '30 minutes',
    fix: 'Add Open Graph (og:title, og:description, og:image, og:url) and Twitter Card tags in your shared head template.',
    example: '<meta property="og:title" content="...">\n<meta property="og:image" content="https://...">\n<meta name="twitter:card" content="summary_large_image">',
    resources: [{ text: 'Open Graph', url: 'https://ogp.me/' }],
  },
  'Low Open Graph tag coverage': {
    effort: '30 minutes',
    fix: 'Inject OG tags in the layout component so every page has at minimum og:title, og:description, og:image, og:url.',
    resources: [],
  },
  'Default social image used on most pages': {
    effort: '1-2 hours',
    fix: 'Generate per-page og:image (e.g. via dynamic OG image API) so each page has a unique social preview.',
    example: '<meta property="og:image" content="https://example.com/og?title=...">',
    resources: [{ text: 'Vercel OG', url: 'https://vercel.com/docs/og-image-generation' }],
  },
  'Social images use relative URLs': {
    effort: '15 minutes',
    fix: 'og:image must be an absolute URL (https://...). Relative URLs are ignored by social-card scrapers.',
    example: '<meta property="og:image" content="https://example.com/og.png">',
    resources: [],
  },
  'Social images below recommended dimensions': {
    effort: '30 minutes',
    fix: 'Use 1200×630 OG images (1.91:1 ratio). Below this size, social cards render small/blurry.',
    resources: [],
  },
  'YMYL pages without author attribution': {
    effort: '1-2 hours',
    fix: 'Your Money Your Life (medical, financial, legal) pages need a credible author byline with credentials. Strong E-E-A-T signal.',
    example: 'Author: Dr. Jane Smith, MD — Cardiologist (15 years)',
    resources: [{ text: 'E-E-A-T', url: 'https://developers.google.com/search/docs/fundamentals/creating-helpful-content' }],
  },
  'YMYL page lacks trust signals': {
    effort: '1-2 hours',
    fix: 'Add trust signals to YMYL pages: author credentials, citations, fact-check date, reviewed-by line, privacy/terms links.',
    resources: [],
  },
  'YMYL page without author attribution': {
    effort: '30 minutes',
    fix: 'Add a credible byline with credentials to this YMYL page.',
    resources: [],
  },
  'Low E-E-A-T signals across site': {
    effort: '4-8 hours',
    fix: 'Audit Experience/Expertise/Authoritativeness/Trust signals: author bios, about page, contact, privacy policy, citations.',
    resources: [{ text: 'E-E-A-T', url: 'https://developers.google.com/search/docs/fundamentals/creating-helpful-content' }],
  },
  'dateModified is earlier than datePublished': {
    effort: '5 minutes',
    fix: 'Fix schema dates — modified cannot be before published. Often a CMS bug.',
    resources: [],
  },

  // ─── Accessibility: forms / motion / ARIA ────────────────────────────────
  'form inputs across site missing labels': {
    effort: '30 minutes',
    fix: 'Associate every <input> with a <label> using for/id. Required for screen readers.',
    example: '<label for="email">Email</label>\n<input id="email" name="email" type="email">',
    resources: [{ text: 'Form Labels', url: 'https://www.w3.org/WAI/tutorials/forms/labels/' }],
  },
  'pages have form accessibility issues': {
    effort: '1 hour',
    fix: 'Audit form pages — common issues: missing labels, missing autocomplete, positive tabindex, missing submit button.',
    resources: [{ text: 'Forms Tutorial', url: 'https://www.w3.org/WAI/tutorials/forms/' }],
  },
  'Form inputs missing autocomplete attribute': {
    effort: '10 minutes',
    fix: 'Add autocomplete attributes to common fields (email, name, address, cc-number, etc). Helps both UX and accessibility.',
    example: '<input type="email" autocomplete="email" name="email">',
    resources: [{ text: 'autocomplete', url: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/autocomplete' }],
  },
  'Form uses positive tabindex': {
    effort: '15 minutes',
    fix: 'Avoid positive tabindex (tabindex >= 1). It breaks natural focus order. Use 0 or -1, or rely on DOM order.',
    example: '<button tabindex="0">OK</button>   <!-- not tabindex="5" -->',
    resources: [],
  },
  'Form without submit button': {
    effort: '5 minutes',
    fix: 'Forms need a <button type="submit"> or <input type="submit">. Enter-to-submit relies on it.',
    example: '<button type="submit">Send</button>',
    resources: [],
  },
  'Form submits to itself via GET': {
    effort: '15 minutes',
    fix: 'The form has an empty/missing action and uses GET, so submitted fields are exposed in the URL (bookmarked, logged, and cached) instead of sent to a handler. Set an explicit action pointing at your endpoint and use method="post" for anything that collects user data.',
    example: '<form action="/contact" method="post"> … </form>',
    resources: [],
  },
  'Placeholder used instead of label': {
    effort: '15 minutes',
    fix: 'Placeholder is not a label — it disappears on focus and has poor contrast. Always pair an input with a visible <label>.',
    example: '<label for="email">Email</label>\n<input id="email" placeholder="you@example.com">',
    resources: [],
  },
  'Autoplay video without pause controls': {
    effort: '15 minutes',
    fix: 'Autoplaying media must have visible pause/stop controls. Better: do not autoplay, or only autoplay muted with explicit user action.',
    example: '<video controls muted autoplay playsinline>...</video>',
    resources: [{ text: 'WCAG 1.4.2', url: 'https://www.w3.org/WAI/WCAG21/Understanding/audio-control.html' }],
  },
  'Excessive use of assertive live regions': {
    effort: '20 minutes',
    fix: 'aria-live="assertive" interrupts screen reader output. Use only for genuine alerts. Prefer "polite" for non-critical updates.',
    example: '<div aria-live="polite">New message arrived</div>',
    resources: [],
  },
  'Videos without captions or transcripts': {
    effort: '1-2 hours',
    fix: 'Provide captions (WebVTT) and a transcript for every video. Required by WCAG 1.2.2 and helps SEO.',
    example: '<video controls><track kind="captions" src="captions.vtt" srclang="en"></video>',
    resources: [{ text: 'WCAG Captions', url: 'https://www.w3.org/WAI/WCAG21/Understanding/captions-prerecorded.html' }],
  },
  'videos across site lack captions': {
    effort: '2-4 hours',
    fix: 'Add captions to every video site-wide. Auto-generated as a starting point, then proofread.',
    resources: [],
  },

  // ─── Shadow DOM / Web Components ─────────────────────────────────────────
  'Heading content in Shadow DOM': {
    effort: '1 hour',
    fix: 'Headings inside closed/encapsulated Shadow DOM may not be indexed. Render headings in light DOM or use declarative Shadow DOM with SSR.',
    resources: [{ text: 'Declarative Shadow DOM', url: 'https://web.dev/articles/declarative-shadow-dom' }],
  },
  'Most content in Shadow DOM': {
    effort: '2-4 hours',
    fix: 'Most of the page is inside Shadow DOM. Crawlers may not see it. Use declarative Shadow DOM (SSR shadowroot) so HTML is present in the initial response.',
    resources: [],
  },
  'Significant content in Shadow DOM': {
    effort: '2 hours',
    fix: 'Significant content sits inside Shadow DOM. Switch to declarative Shadow DOM with SSR for SEO.',
    resources: [],
  },
  'pages have important content in Shadow DOM': {
    effort: '2-4 hours',
    fix: 'Important content inside Shadow DOM may not be indexed. Migrate to declarative Shadow DOM with SSR.',
    resources: [],
  },
  'Heavy Shadow DOM usage across site': {
    effort: '4-8 hours',
    fix: 'Site uses Shadow DOM heavily. Verify each component supports declarative SSR; otherwise migrate critical content out.',
    resources: [],
  },
  'Links inside Shadow DOM': {
    effort: '1 hour',
    fix: 'Internal links inside Shadow DOM may not be followed by crawlers. Surface them in light DOM or use declarative Shadow DOM.',
    resources: [],
  },
  'Images inside Shadow DOM': {
    effort: '1 hour',
    fix: 'Images inside Shadow DOM may not be indexed in Google Images. Use declarative Shadow DOM SSR.',
    resources: [],
  },
  'No declarative Shadow DOM fallback': {
    effort: '2 hours',
    fix: 'Components rendering in Shadow DOM lack an SSR fallback. Add declarative Shadow DOM (<template shadowrootmode="open">).',
    example: '<my-component><template shadowrootmode="open">...</template></my-component>',
    resources: [{ text: 'Declarative Shadow DOM', url: 'https://web.dev/articles/declarative-shadow-dom' }],
  },

  // ─── AI readiness / AEO ──────────────────────────────────────────────────
  'Site-wide low semantic HTML usage for AI readiness': {
    effort: '2-4 hours',
    fix: 'AI extractors look for semantic landmarks (<article>, <section>, <nav>, <main>, <header>, <footer>). Replace generic divs with semantic elements.',
    example: '<main>\n  <article>\n    <header><h1>...</h1></header>\n    ...\n  </article>\n</main>',
    resources: [],
  },
  'Low AI content structure score': {
    effort: '2 hours',
    fix: 'Add semantic structure (headings, FAQ patterns, schema) so AI extractors can lift key content cleanly.',
    resources: [],
  },

  // ─── Content media / iframes ─────────────────────────────────────────────
  'Content may be hidden in iframes': {
    effort: '30 minutes',
    fix: 'Content in iframes is not associated with the parent page for SEO. Inline the content or use srcdoc for small fragments.',
    resources: [],
  },
  'Ad density exceeds 30% of viewport': {
    effort: '1 hour',
    fix: 'Reduce above-the-fold ads. Google\'s ad-density guidelines penalize >30% above-the-fold ad coverage.',
    resources: [{ text: 'Ad Experience', url: 'https://support.google.com/adsense/answer/9959599' }],
  },
  'High ad density (% of viewport)': {
    effort: '1 hour',
    fix: 'Reduce ad density above the fold. Reposition ads further down the page.',
    resources: [],
  },

  // ─── Analytics ───────────────────────────────────────────────────────────
  'Many pages missing analytics': {
    effort: '30 minutes',
    fix: 'Add the analytics snippet to the shared layout so every page reports. Currently many pages have no measurement.',
    resources: [],
  },
  'Low GA4 coverage across site': {
    effort: '30 minutes',
    fix: 'GA4 snippet missing on many pages. Move it into the root layout or _app/_document.',
    resources: [],
  },
  'Inconsistent GA4 measurement IDs across pages': {
    effort: '15 minutes',
    fix: 'Different GA4 IDs are firing across pages. Standardize on one measurement ID via a shared config/env var.',
    resources: [],
  },
  'Inconsistent Universal Analytics IDs across pages': {
    effort: '15 minutes',
    fix: 'Multiple UA-* IDs detected. UA is sunset — migrate everything to GA4.',
    resources: [{ text: 'GA4 Migration', url: 'https://support.google.com/analytics/answer/10759417' }],
  },
  'Inconsistent GTM container IDs across pages': {
    effort: '15 minutes',
    fix: 'Different GTM containers on different pages. Standardize on one.',
    resources: [],
  },
  'Still using Universal Analytics only': {
    effort: '2-4 hours',
    fix: 'Universal Analytics stopped processing data on July 1, 2023. Migrate to GA4 immediately.',
    resources: [{ text: 'GA4 Migration', url: 'https://support.google.com/analytics/answer/10759417' }],
  },
  'Both Universal Analytics and GA4 detected': {
    effort: '15 minutes',
    fix: 'UA is sunset. Remove the UA snippet and run only GA4.',
    resources: [],
  },

  // ─── Repo / framework-specific ───────────────────────────────────────────
  'Root layout missing metadata export': {
    effort: '15 minutes',
    fix: 'Next.js App Router: export a `metadata` (or `generateMetadata`) object from the root layout so default title/description are set.',
    example: 'export const metadata = { title: { default: "Site", template: "%s | Site" }, description: "..." };',
    resources: [{ text: 'Next Metadata', url: 'https://nextjs.org/docs/app/api-reference/functions/generate-metadata' }],
  },
  'No page files export metadata': {
    effort: '30 minutes',
    fix: 'Pages do not export metadata. Add per-page metadata or generateMetadata for unique titles/descriptions.',
    resources: [],
  },
  'Layout files may lack dynamic meta tags': {
    effort: '30 minutes',
    fix: 'Layouts should set base metadata; pages should override with generateMetadata for dynamic content.',
    resources: [],
  },
  'Missing robots.ts in Next.js App Router': {
    effort: '5 minutes',
    fix: 'Add app/robots.ts to generate robots.txt from code so it stays in sync with your routes.',
    example: 'export default function robots() { return { rules: [{ userAgent: "*", allow: "/" }], sitemap: "https://example.com/sitemap.xml" }; }',
    resources: [{ text: 'Next robots', url: 'https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots' }],
  },
  'Missing sitemap.ts in Next.js App Router': {
    effort: '15 minutes',
    fix: 'Add app/sitemap.ts to generate sitemap.xml from your route list.',
    example: 'export default async function sitemap() { return [{ url: "https://example.com/", lastModified: new Date() }]; }',
    resources: [{ text: 'Next sitemap', url: 'https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap' }],
  },
  'Missing @astrojs/sitemap integration': {
    effort: '5 minutes',
    fix: 'Install @astrojs/sitemap and add it to astro.config.mjs integrations.',
    example: 'npx astro add sitemap',
    resources: [{ text: 'Astro Sitemap', url: 'https://docs.astro.build/en/guides/integrations-guide/sitemap/' }],
  },
  'Missing gatsby-plugin-sitemap': {
    effort: '5 minutes',
    fix: 'Install gatsby-plugin-sitemap and add to gatsby-config.js plugins.',
    example: 'npm install gatsby-plugin-sitemap',
    resources: [],
  },
  'No useHead or useSeoMeta usage found': {
    effort: '30 minutes',
    fix: 'Nuxt 3: use useHead() or useSeoMeta() inside pages for per-page SEO.',
    example: 'useSeoMeta({ title: "...", ogImage: "..." });',
    resources: [{ text: 'Nuxt SEO', url: 'https://nuxt.com/docs/getting-started/seo-meta' }],
  },
  'Nuxt config missing app.head configuration': {
    effort: '10 minutes',
    fix: 'Add baseline head config (title template, meta description, lang) to nuxt.config.ts.',
    example: 'export default defineNuxtConfig({ app: { head: { htmlAttrs: { lang: "en" }, title: "Default" } } });',
    resources: [],
  },
  'No head management strategy detected': {
    effort: '1 hour',
    fix: 'Adopt a head-management approach for your framework (Next metadata API, react-helmet-async, Nuxt useHead, Astro <head>) and use it consistently.',
    resources: [],
  },
  'Dynamic imports with ssr: false break SEO': {
    effort: '30 minutes',
    fix: 'next/dynamic with ssr:false produces client-only components — their content is not in SSR HTML. Remove ssr:false on SEO-critical components.',
    example: 'const Comp = dynamic(() => import("./Comp"));   // not { ssr: false }',
    resources: [],
  },
  'Next.js version requires a newer React': {
    effort: '1-2 hours',
    fix: 'Upgrade React to the version Next.js requires. Mismatched versions cause runtime bugs and missing features.',
    example: 'npm install react@latest react-dom@latest',
    resources: [],
  },
  "Routes export `dynamic = 'force-dynamic'`": {
    effort: '20 minutes',
    fix: 'force-dynamic disables ISR/static optimization. Use it only when needed (per-request data); otherwise remove for better performance.',
    resources: [],
  },
  'fetch() calls disable the Next.js data cache': {
    effort: '15 minutes',
    fix: 'fetch() with { cache: "no-store" } or revalidate:0 misses caching. Remove if cacheable, or set revalidate to a sensible TTL.',
    resources: [],
  },
  'Using plain tags instead of next/image': {
    effort: '30 minutes',
    fix: 'Switch <img> to next/image for automatic optimization (responsive srcset, lazy loading, AVIF/WebP).',
    example: 'import Image from "next/image";\n<Image src="/photo.jpg" width={800} height={600} alt="..." />',
    resources: [{ text: 'next/image', url: 'https://nextjs.org/docs/app/api-reference/components/image' }],
  },
  'lodash imported as a whole library': {
    effort: '10 minutes',
    fix: 'Import only what you need: `import debounce from "lodash/debounce"`. The barrel import pulls the full lodash bundle.',
    example: 'import debounce from "lodash/debounce";  // not: import _ from "lodash";',
    resources: [],
  },
  'detected - verify server-side rendering': {
    effort: '30 minutes',
    fix: 'Verify the route renders server-side (curl the URL and check the HTML). Some frameworks default to client rendering for certain routes.',
    example: 'curl -s https://example.com/page | grep -c "<h1>"',
    resources: [],
  },

  // ─── High-error / segment ────────────────────────────────────────────────
  'High error rate in': {
    effort: '1 hour',
    fix: 'A site segment has a disproportionately high error rate. Investigate logs and fix the top error.',
    resources: [],
  },

  // ─── Misc analyzers (non-`message:`-style emitters) ──────────────────────
  'Pages sit behind a long redirect chain': {
    effort: '30 minutes',
    fix: 'The page redirects more than twice before reaching its destination. Collapse the chain so the original URL 301s straight to the final URL, and update internal links to point at the final URL.',
    resources: [{ text: '301 Redirects', url: 'https://developers.google.com/search/docs/crawling-indexing/301-redirects' }],
  },
  'URL too long for analysis': {
    effort: '20 minutes',
    fix: 'URL exceeds 2000 characters. Shorten the path, drop unnecessary parameters, or move state into the body/cookies. Long URLs may be truncated by crawlers.',
    resources: [],
  },
  'URL is empty or undefined': {
    effort: '15 minutes',
    fix: 'A URL value is empty or undefined where one was expected. Likely a data-pipeline bug — verify the source provides a value.',
    resources: [],
  },
  // Single canonical URL-length finding (tier-twin collapsed, report-rules.md §5).
  // Covers both the >recommended and >max bands; the crossed band is in the detail.
  'URL is too long': {
    effort: '20 minutes',
    fix: 'URL is longer than recommended for SEO (the detail shows the length and which band it crossed). Shorten by removing unnecessary path segments or moving state to query/POST — search results display only ~70 characters of the URL.',
    resources: [],
  },
  'URL is too deep': {
    effort: '30 minutes',
    fix: 'URL path nesting exceeds recommended depth. Flatten the URL structure — content buried >4 levels deep ranks worse.',
    resources: [],
  },
  'Some URLs are too long': {
    effort: '30 minutes',
    fix: 'Multiple URLs exceed 100 characters. Audit and shorten high-impact pages.',
    resources: [],
  },
  'URL exceeds 200 characters': {
    effort: '20 minutes',
    fix: 'URL is excessively long. Shorten path segments, drop tracking params, or move state to query/POST.',
    resources: [],
  },
  // ─── Crawler / page-data-builder messages (positional reportIssue) ───────
  'Description meta tag is missing': {
    effort: '15 minutes',
    fix: 'Add a <meta name="description"> tag (~150-160 chars) summarizing the page. Improves SERP click-through.',
    example: '<meta name="description" content="...">',
    resources: [{ text: 'Meta Description', url: 'https://moz.com/learn/seo/meta-description' }],
  },
  'Some alternates are duplicated in head links': {
    effort: '15 minutes',
    fix: 'Multiple <link rel="alternate"> entries point to the same URL. Deduplicate so each hreflang/locale appears once.',
    resources: [],
  },
  'Requested URLs redirect before serving the page': {
    effort: '30 minutes',
    fix: 'A single redirect is not a problem in itself — but the requested URL (sitemap entry or internal link) is not the final URL. Point sitemap entries and internal href values directly at the final URL to save a round-trip and preserve link equity.',
    resources: [{ text: '301 Redirects', url: 'https://developers.google.com/search/docs/crawling-indexing/301-redirects' }],
  },
  'Some pages have links without any text': {
    effort: '30 minutes',
    fix: 'Add visible text or aria-label to icon-only/empty links. Empty anchors are invisible to screen readers and crawlers.',
    example: '<a href="/cart" aria-label="Shopping cart"><svg>...</svg></a>',
    resources: [],
  },
  'Some pages have FCP more than 1800ms': {
    effort: '30 minutes',
    fix: 'First Contentful Paint is slow. Inline critical CSS, defer non-critical JS, optimize TTFB, and preload above-the-fold resources.',
    resources: [{ text: 'Optimize FCP', url: 'https://web.dev/articles/fcp' }],
  },
  'Some pages have CLS more than 0.1': {
    effort: '30 minutes',
    fix: 'Layout shifts above 0.1 hurt UX and SEO. Always set width/height on <img>/<video>, reserve space for ads/embeds with CSS aspect-ratio, and avoid inserting content above existing content.',
    example: '<img src="hero.webp" width="1200" height="600">  <!-- size hints prevent shift -->',
    resources: [{ text: 'Optimize CLS', url: 'https://web.dev/articles/optimize-cls' }],
  },
  'Some pages have INP more than 200ms': {
    effort: '1 hour',
    fix: 'Interaction-to-Next-Paint is slow. Reduce main-thread work in event handlers: defer non-critical work, debounce, use requestIdleCallback for non-urgent tasks.',
    resources: [{ text: 'Optimize INP', url: 'https://web.dev/articles/inp' }],
  },
  'Some pages have TBT more than 200ms': {
    effort: '1-2 hours',
    fix: 'High Total Blocking Time means long JavaScript tasks are freezing the main thread. Code-split large bundles and defer non-critical scripts, break long tasks into smaller chunks (yield with scheduler.yield/setTimeout), remove unused JS, and move heavy work to a Web Worker.',
    resources: [
      { text: 'Optimize TBT', url: 'https://web.dev/articles/tbt' },
      { text: 'Long tasks', url: 'https://web.dev/articles/optimize-long-tasks' },
    ],
  },
  'Some pages have too many requests': {
    effort: '30 minutes',
    fix: 'Page makes too many HTTP requests. Combine assets, use sprites/icon-fonts/inline-SVG, lazy-load below-the-fold resources.',
    resources: [],
  },
  'Low semantic HTML usage': {
    effort: '1-2 hours',
    fix: 'Replace generic <div> with semantic elements (<header>, <nav>, <main>, <article>, <section>, <footer>). Helps accessibility, SEO, and AI extraction.',
    example: '<main>\n  <article>\n    <header><h1>...</h1></header>\n    <section>...</section>\n  </article>\n</main>',
    resources: [{ text: 'HTML Semantics', url: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements#content_sectioning' }],
  },
  // ─── SEO: titles / descriptions / anchors / authorship ────────────────────
  'Some pages have titles that are too long': {
    effort: '30 minutes',
    fix: 'Trim titles to ~60 characters (≈600px) so Google does not truncate them in the SERP. Front-load the primary keyword, drop redundant boilerplate, and keep the brand suffix short ("| Brand").',
    example: '<title>Primary Keyword — Concise Page Topic | Brand</title>',
    resources: [{ text: 'Title link best practices', url: 'https://developers.google.com/search/docs/appearance/title-link' }],
  },
  'Some pages have titles that are too short': {
    effort: '30 minutes',
    fix: 'Expand bare titles to ≥30 characters so they describe the page and use the available result width. Add the primary keyword and a short brand suffix; keep one distinct title per page.',
    example: '<title>SMS Terms of Service — Policies & Opt-Out | Brand</title>',
    resources: [{ text: 'Title link best practices', url: 'https://developers.google.com/search/docs/appearance/title-link' }],
  },
  'Some pages have descriptions that are too long': {
    effort: '30 minutes',
    fix: 'Shorten meta descriptions to ~150-160 characters so they are not cut off in search results. Lead with the page\'s unique value and a call to action; write one distinct description per page.',
    example: '<meta name="description" content="One clear, ~150-character summary of this page that leads with its unique value and ends with a call to action.">',
    resources: [{ text: 'Meta descriptions', url: 'https://developers.google.com/search/docs/appearance/snippet' }],
  },
  'Some pages have descriptions that are too short': {
    effort: '30 minutes',
    fix: 'Expand thin meta descriptions to 120-160 characters so they fully describe the page and use the available SERP space. Lead with the page\'s unique value; write one distinct description per page.',
    example: '<meta name="description" content="A full 120–160 character summary that describes this page\'s unique value and what the visitor will get.">',
    resources: [{ text: 'Meta descriptions', url: 'https://developers.google.com/search/docs/appearance/snippet' }],
  },
  'Multiple pages target the same keyword in their titles': {
    effort: '1-2 hours',
    fix: 'Several pages compete for the same query (keyword cannibalisation), splitting ranking signals. Give each page a distinct primary keyword and intent, consolidate near-duplicates into one stronger page (301 the rest), and differentiate the titles accordingly.',
    resources: [{ text: 'Keyword cannibalisation', url: 'https://moz.com/learn/seo/keyword-cannibalization' }],
  },
  'Duplicate anchor text': {
    effort: '30 minutes',
    fix: 'The same anchor text repeats across many links, diluting its relevance signal. Use descriptive, varied anchor text that reflects each link\'s destination instead of generic repeated phrases.',
    resources: [{ text: 'Anchor text best practices', url: 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable' }],
  },
  'Same anchor text links to different pages': {
    effort: '30 minutes',
    fix: 'Identical anchor text points to different destinations, confusing users and crawlers about each target\'s topic. Make anchor text uniquely describe its specific destination.',
    resources: [{ text: 'Anchor text best practices', url: 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable' }],
  },
  'No author information found': {
    effort: '1 hour',
    fix: 'Add a visible author byline and machine-readable authorship (Person schema + rel="author") so search engines can attribute expertise — an E-E-A-T signal, especially for YMYL and editorial content.',
    example: '<script type="application/ld+json">{"@type":"Article","author":{"@type":"Person","name":"Jane Doe"}}</script>',
    resources: [{ text: 'E-E-A-T', url: 'https://developers.google.com/search/docs/fundamentals/creating-helpful-content' }],
  },
  'Low text-to-HTML ratio': {
    effort: '1-2 hours',
    fix: 'Markup heavily outweighs visible text. Trim wrapper <div> nesting and inline styles/scripts, move CSS/JS to external files, and ensure substantive text content is server-rendered rather than buried in markup.',
    resources: [{ text: 'DOM size', url: 'https://developer.chrome.com/docs/lighthouse/performance/dom-size' }],
  },
  'CSS/JS files may be blocked': {
    effort: '15 minutes',
    fix: 'robots.txt disallows CSS/JS resources, so Googlebot cannot fully render the page and may misjudge layout, mobile-friendliness, and content. Remove the Disallow rules that block .css/.js (and other render-critical assets) so crawlers can fetch them.',
    example: 'User-agent: *\nAllow: /*.css$\nAllow: /*.js$',
    resources: [{ text: 'Blocked resources', url: 'https://developers.google.com/search/docs/crawling-indexing/robots/intro' }],
  },
  'Too many on-page links': {
    effort: '1-2 hours',
    fix: 'A very high link count per page dilutes the link equity each link passes and makes the page harder to crawl and read. Trim navigation/footer link dumps, paginate long link lists, and keep links focused on the page\'s primary intent.',
    resources: [{ text: 'Crawl budget', url: 'https://developers.google.com/search/docs/crawling-indexing/large-site-managing-crawl-budget' }],
  },
};
