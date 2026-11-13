/**
 * Version extraction for the fingerprint pass: reads versions from what a site publishes to every
 * visitor (generator tags, response headers, versioned asset URLs, and — in the browser retry —
 * library globals). Nothing here makes a request.
 *
 * A version is only as good as its source, so every observation keeps its `kind`. The truth gate
 * cites a version only when two different kinds agree on it.
 */

import { libraryFromUrl, LIBRARIES } from '../analyzers/security/js-library-analyzer';
import type { SignalKind, VersionEvidence, VersionFinding } from './types';

export interface ProductInfo {
  label: string;
  /** What the product is, which decides whether an end-of-life hit may be raised for it. */
  role: 'cms' | 'framework' | 'runtime' | 'library' | 'server';
}

/** Slugs match the public end-of-life dataset (endoflife.date) wherever it covers the product. */
export const PRODUCTS: Record<string, ProductInfo> = {
  wordpress: { label: 'WordPress', role: 'cms' },
  drupal: { label: 'Drupal', role: 'cms' },
  joomla: { label: 'Joomla', role: 'cms' },
  typo3: { label: 'TYPO3', role: 'cms' },
  magento: { label: 'Magento', role: 'cms' },
  'craft-cms': { label: 'Craft CMS', role: 'cms' },
  'concrete-cms': { label: 'Concrete CMS', role: 'cms' },
  contao: { label: 'Contao', role: 'cms' },
  umbraco: { label: 'Umbraco', role: 'cms' },
  shopware: { label: 'Shopware', role: 'cms' },
  sitefinity: { label: 'Sitefinity', role: 'cms' },
  ghost: { label: 'Ghost', role: 'cms' },
  prestashop: { label: 'PrestaShop', role: 'cms' },
  gatsby: { label: 'Gatsby', role: 'framework' },
  astro: { label: 'Astro', role: 'framework' },
  hugo: { label: 'Hugo', role: 'framework' },
  nextjs: { label: 'Next.js', role: 'framework' },
  nuxt: { label: 'Nuxt', role: 'framework' },
  angular: { label: 'Angular', role: 'framework' },
  angularjs: { label: 'AngularJS', role: 'framework' },
  vue: { label: 'Vue', role: 'framework' },
  react: { label: 'React', role: 'framework' },
  php: { label: 'PHP', role: 'runtime' },
  aspnet: { label: 'ASP.NET', role: 'runtime' },
  nginx: { label: 'nginx', role: 'server' },
  apache: { label: 'Apache', role: 'server' },
  iis: { label: 'IIS', role: 'server' },
  jquery: { label: 'jQuery', role: 'library' },
  'jquery-ui': { label: 'jQuery UI', role: 'library' },
  bootstrap: { label: 'Bootstrap', role: 'library' },
  lodash: { label: 'Lodash', role: 'library' },
  underscore: { label: 'Underscore', role: 'library' },
  moment: { label: 'Moment.js', role: 'library' },
  handlebars: { label: 'Handlebars', role: 'library' },
  dompurify: { label: 'DOMPurify', role: 'library' },
};

/** Detector technology name → product slug, for the CMSs and frameworks that can carry a version. */
export const TECH_TO_PRODUCT: Record<string, string> = {
  WordPress: 'wordpress',
  Drupal: 'drupal',
  Joomla: 'joomla',
  TYPO3: 'typo3',
  Magento: 'magento',
  'Craft CMS': 'craft-cms',
  'Concrete CMS': 'concrete-cms',
  Contao: 'contao',
  Umbraco: 'umbraco',
  Sitefinity: 'sitefinity',
  Ghost: 'ghost',
  PrestaShop: 'prestashop',
  Gatsby: 'gatsby',
  Astro: 'astro',
  'Next.js': 'nextjs',
  'Nuxt.js': 'nuxt',
  Angular: 'angular',
  AngularJS: 'angularjs',
  'Vue.js': 'vue',
  React: 'react',
};

const V = '(\\d+(?:\\.\\d+){0,3})';

/** `<meta name="generator">` content → product. The version group is optional for some platforms. */
const GENERATOR_PATTERNS: Array<[RegExp, string]> = [
  [new RegExp(`^WordPress\\s+${V}`, 'i'), 'wordpress'],
  [new RegExp(`^Drupal\\s+${V}`, 'i'), 'drupal'],
  [new RegExp(`^Joomla!?\\s+${V}`, 'i'), 'joomla'],
  [new RegExp(`^TYPO3\\s+(?:CMS\\s+)?${V}`, 'i'), 'typo3'],
  [new RegExp(`^concrete5\\s*-\\s*${V}`, 'i'), 'concrete-cms'],
  [new RegExp(`^Concrete CMS\\s*-?\\s*${V}`, 'i'), 'concrete-cms'],
  [new RegExp(`^Contao\\s+(?:Open Source CMS\\s+)?${V}`, 'i'), 'contao'],
  [new RegExp(`^Sitefinity\\s+${V}`, 'i'), 'sitefinity'],
  [new RegExp(`^Ghost\\s+${V}`, 'i'), 'ghost'],
  [new RegExp(`^PrestaShop\\s+${V}`, 'i'), 'prestashop'],
  [new RegExp(`^Shopware\\s+${V}`, 'i'), 'shopware'],
  [new RegExp(`^Gatsby\\s+${V}`, 'i'), 'gatsby'],
  [new RegExp(`^Astro\\s+v?${V}`, 'i'), 'astro'],
  [new RegExp(`^Hugo\\s+${V}`, 'i'), 'hugo'],
];

/**
 * WordPress core files whose `?ver=` is the WordPress version itself. Other files under
 * `/wp-includes/` carry the version of the library they bundle (jQuery, React…), so they are not used.
 */
const WP_CORE_ASSET =
  /\/wp-includes\/(?:js\/wp-emoji-release\.min\.js|js\/wp-embed\.min\.js|css\/dist\/block-library\/style(?:\.min)?\.css|css\/dashicons(?:\.min)?\.css)\?(?:[^"'\s<>]*&(?:amp;)?)?ver=(\d+\.\d+(?:\.\d+)?)(?![\w.])/gi;

const WP_JQUERY_ASSET =
  /\/wp-includes\/js\/jquery\/jquery(?:\.min)?\.js\?(?:[^"'\s<>]*&(?:amp;)?)?ver=(\d+\.\d+\.\d+)/i;

function metaGenerators(html: string): string[] {
  const out: string[] = [];
  const tagRe = /<meta\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const tag = match[0];
    if (!/\bname\s*=\s*["']?generator["']?/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const value = (content?.[1] ?? content?.[2] ?? '').trim();
    if (value) out.push(value);
  }
  return out;
}

function header(headers: Record<string, string>, name: string): string {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? String(headers[key] ?? '') : '';
}

export interface VersionInput {
  /** Raw HTML, original case. */
  html: string;
  headers: Record<string, string>;
  /** Absolute or relative script URLs, original case. */
  scriptSrcs: string[];
  /** Library slug → version read from runtime globals (browser retry only). */
  runtime?: Record<string, string>;
}

export function extractVersions(input: VersionInput): VersionFinding[] {
  const findings: VersionFinding[] = [];
  const add = (product: string, version: string, kind: SignalKind, source: string) => {
    const info = PRODUCTS[product];
    if (!info || !version) return;
    findings.push({ product, label: info.label, version, kind, source });
  };

  for (const generator of metaGenerators(input.html)) {
    for (const [pattern, product] of GENERATOR_PATTERNS) {
      const m = pattern.exec(generator);
      if (m) {
        add(product, m[1], 'meta', 'meta generator');
        break;
      }
    }
  }

  const xGenerator = header(input.headers, 'x-generator');
  const drupalHeader = new RegExp(`Drupal\\s+${V}`, 'i').exec(xGenerator);
  if (drupalHeader) add('drupal', drupalHeader[1], 'header', 'x-generator');

  const poweredBy = header(input.headers, 'x-powered-by');
  const php = /PHP\/(\d+\.\d+(?:\.\d+)?)/i.exec(poweredBy);
  if (php) add('php', php[1], 'header', 'x-powered-by');
  const aspnet = /(\d+\.\d+(?:\.\d+)?)/.exec(header(input.headers, 'x-aspnet-version'));
  if (aspnet) add('aspnet', aspnet[1], 'header', 'x-aspnet-version');

  const server = header(input.headers, 'server');
  const nginx = /nginx\/(\d+\.\d+(?:\.\d+)?)/i.exec(server);
  if (nginx) add('nginx', nginx[1], 'header', 'server');
  const apache = /Apache\/(\d+\.\d+(?:\.\d+)?)/i.exec(server);
  if (apache) add('apache', apache[1], 'header', 'server');
  const iis = /Microsoft-IIS\/(\d+\.\d+)/i.exec(server);
  if (iis) add('iis', iis[1], 'header', 'server');

  // WordPress version from the core files that carry it.
  const wpVersions = new Set<string>();
  for (const m of input.html.matchAll(WP_CORE_ASSET)) wpVersions.add(m[1]);
  if (wpVersions.size === 1) add('wordpress', [...wpVersions][0], 'source', '/wp-includes/ core asset ?ver=');

  const wpJquery = WP_JQUERY_ASSET.exec(input.html);
  if (wpJquery) add('jquery', wpJquery[1], 'source', '/wp-includes/js/jquery/ ?ver=');

  const ngVersion = /\bng-version="(\d+\.\d+\.\d+)[^"]*"/i.exec(input.html);
  if (ngVersion) add('angular', ngVersion[1], 'source', 'ng-version attribute');

  // Nuxt 2 is recognisable from its markup; later majors are not told apart, so they give no version.
  if (frameworkVariants(input.html).some((v) => v.framework === 'Nuxt.js' && v.variant === '2')) {
    add('nuxt', '2', 'source', 'Nuxt 2 markup');
  }

  const seenLibs = new Set<string>();
  for (const src of input.scriptSrcs) {
    const absolute = /^https?:\/\//i.test(src) ? src : `https://site.invalid/${src.replace(/^\/+/, '')}`;
    const hit = libraryFromUrl(absolute);
    if (hit && !seenLibs.has(hit.lib)) {
      seenLibs.add(hit.lib);
      add(hit.lib, hit.version, 'source', 'script URL');
    }
  }

  for (const [lib, version] of Object.entries(input.runtime ?? {})) {
    add(lib, version, 'global', 'runtime global');
  }

  return findings;
}

/** `6.4` and `6.4.2` agree; `6.4.2` and `6.3.1` do not. */
export function versionsCompatible(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

const KIND_PRIORITY: SignalKind[] = ['meta', 'header', 'global', 'source', 'cookie', 'asset-host'];

/** Groups observations by product and keeps the kinds that agree on one version. */
export function mergeVersions(findings: VersionFinding[]): VersionEvidence[] {
  const byProduct = new Map<string, VersionFinding[]>();
  for (const f of findings) byProduct.set(f.product, [...(byProduct.get(f.product) ?? []), f]);

  const merged: VersionEvidence[] = [];
  for (const [product, list] of byProduct) {
    const ordered = list.slice().sort((a, b) => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind));
    const lead = ordered[0];
    const agreeing = ordered.filter((f) => versionsCompatible(f.version, lead.version));
    const version = agreeing.reduce((best, f) => (f.version.length > best.length ? f.version : best), lead.version);
    const evidence: VersionEvidence = {
      product,
      label: lead.label,
      version,
      kinds: [...new Set(agreeing.map((f) => f.kind))],
      sources: [...new Set(agreeing.map((f) => f.source))],
    };
    if (agreeing.length < ordered.length) evidence.conflict = true;
    merged.push(evidence);
  }
  return merged;
}

/** Library slugs the advisory table knows, for the "libraries" list of a stack profile. */
export const LIBRARY_PRODUCTS = new Set(Object.keys(LIBRARIES));

export interface FrameworkVariant {
  framework: string;
  variant: string;
}

/**
 * Variants that matter for a pitch but carry no version number in public HTML:
 * the Next.js router type and the Nuxt major version.
 */
export function frameworkVariants(html: string): FrameworkVariant[] {
  const out: FrameworkVariant[] = [];
  const hasFlight = /self\.__next_f\b/.test(html);
  const hasPagesData = /<script[^>]+id=["']__NEXT_DATA__["']/i.test(html);
  if (hasFlight) out.push({ framework: 'Next.js', variant: 'App Router' });
  else if (hasPagesData) out.push({ framework: 'Next.js', variant: 'Pages Router' });

  if (/id=["']__NUXT_DATA__["']|data-nuxt-data|window\.__NUXT__\s*=\s*\{\s*\}/i.test(html)) {
    out.push({ framework: 'Nuxt.js', variant: '3+' });
  } else if (/\bdata-n-head(?:-ssr)?=|id=["']__layout["']/i.test(html)) {
    out.push({ framework: 'Nuxt.js', variant: '2' });
  }
  return out;
}
