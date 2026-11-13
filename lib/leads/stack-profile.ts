/**
 * Turns raw detections into a stack profile: which CMS, what kind of stack, and how sure we are.
 * Pure: no requests. Rules are in `docs/gtm/sales-audit-system.md` ("Stage 1: fingerprint").
 *
 * Two rules decide everything here:
 *
 *  1. Two-kinds rule. A stack claim is `high` confidence only when two different kinds of signal
 *     agree (a cookie and a path, a generator tag and a header…). Hits of the same kind do not add up.
 *  2. An asset host proves which service serves the files, not which CMS runs the site. On its own it
 *     never makes a site `headless`; next to a legacy CMS it makes the stack `hybrid`.
 */

import type { DetectedTechnology, DetectionMethod } from '../analyzers/seo/technology-detector';
import { eolHits } from './eol';
import { LIBRARY_PRODUCTS, PRODUCTS, TECH_TO_PRODUCT, frameworkVariants, type FrameworkVariant } from './versions';
import type {
  SignalKind,
  StackConfidence,
  StackKind,
  StackProfile,
  StackSignal,
  Track,
  VersionEvidence,
} from './types';

/** Server-rendered, theme-based CMSs and the enterprise suites. */
export const LEGACY_CMS = new Set([
  'WordPress',
  'Drupal',
  'Joomla',
  'TYPO3',
  'Magento',
  'PrestaShop',
  'Concrete CMS',
  'Craft CMS',
  'Contao',
  'ExpressionEngine',
  'Ghost',
  'Sitecore',
  'Adobe Experience Manager',
  'Optimizely CMS',
  'Kentico',
  'Umbraco',
  'Sitefinity',
  'DNN',
]);

/** Hosted builders and hosted commerce. */
export const BUILDER_CMS = new Set(['Wix', 'Squarespace', 'Webflow', 'Shopify', 'BigCommerce', 'HubSpot CMS']);

export const HEADLESS_CMS = new Set([
  'Contentful',
  'Sanity',
  'Strapi',
  'Storyblok',
  'Prismic',
  'DatoCMS',
  'Hygraph',
  'Contentstack',
  'Kontent.ai',
  'Builder.io',
]);

/** Front ends that render a headless CMS. Order = preference when several are present. */
export const JS_FRONTENDS = [
  'Next.js',
  'Nuxt.js',
  'Gatsby',
  'Remix',
  'SvelteKit',
  'Astro',
  'Angular',
  'AngularJS',
  'Vue.js',
  'React',
  'Svelte',
  'Ember.js',
];

/** Frameworks that render the whole site; their presence is evidence of a JavaScript front end. */
export const META_FRAMEWORKS = new Set(['Next.js', 'Nuxt.js', 'Gatsby', 'Remix', 'SvelteKit', 'Astro']);

const KIND_OF_METHOD: Record<string, SignalKind> = {
  cookie: 'cookie',
  header: 'header',
  meta: 'meta',
  global: 'global',
  html: 'source',
  script: 'source',
  'asset-host': 'asset-host',
};

function describeMethod(method: DetectionMethod): string {
  switch (method.type) {
    case 'cookie':
      return `set-cookie ~ /${method.pattern ?? ''}/`;
    case 'header':
      return `${method.header ?? 'header'}: ${method.value ?? ''}`.trim();
    case 'meta':
      return `meta ${method.tag ?? ''}="${method.value ?? ''}"`;
    case 'global':
      return `window.${method.variable ?? ''}`;
    case 'asset-host':
      return method.matched ?? method.pattern ?? '';
    case 'script':
      return method.matched ?? `script ~ /${method.pattern ?? ''}/`;
    default:
      return `html ~ /${method.pattern ?? ''}/`;
  }
}

export function signalsOf(tech: DetectedTechnology): StackSignal[] {
  return tech.detectedBy.map((method) => ({
    tech: tech.name,
    kind: KIND_OF_METHOD[method.type] ?? 'source',
    detail: describeMethod(method),
  }));
}

export const kindsOf = (signals: StackSignal[]): SignalKind[] => [...new Set(signals.map((s) => s.kind))];

interface Candidate {
  name: string;
  signals: StackSignal[];
  kinds: SignalKind[];
  /** Kinds other than `asset-host`: evidence about the site itself. */
  ownKinds: SignalKind[];
}

function candidate(tech: DetectedTechnology): Candidate {
  const signals = signalsOf(tech);
  const kinds = kindsOf(signals);
  return { name: tech.name, signals, kinds, ownKinds: kinds.filter((k) => k !== 'asset-host') };
}

const byStrength = (a: Candidate, b: Candidate) =>
  b.ownKinds.length - a.ownKinds.length || b.kinds.length - a.kinds.length;

export interface ProfileInput {
  technologies: DetectedTechnology[];
  versions: VersionEvidence[];
  /** Raw HTML, for the framework variants (router type, Nuxt major). */
  html?: string;
  /** ISO date used for the end-of-life comparison; defaults to today. */
  today?: string;
}

export function emptyProfile(kind: StackKind, note?: string): StackProfile {
  return {
    kind,
    cms: null,
    cmsSecondary: null,
    cmsVersion: null,
    framework: null,
    frameworkVersion: null,
    runtime: null,
    libraries: [],
    versions: [],
    eol: [],
    confidence: 'low',
    signals: [],
    notes: note ? [note] : [],
  };
}

function versionOf(versions: VersionEvidence[], tech: string | null): VersionEvidence | undefined {
  const product = tech ? TECH_TO_PRODUCT[tech] : undefined;
  return product ? versions.find((v) => v.product === product) : undefined;
}

function runtimeLine(versions: VersionEvidence[]): string | null {
  const parts = versions
    .filter((v) => ['runtime', 'server'].includes(PRODUCTS[v.product]?.role ?? ''))
    .map((v) => `${v.label} ${v.version}`);
  return parts.length ? parts.join('; ') : null;
}

export function buildStackProfile(input: ProfileInput): StackProfile {
  const notes: string[] = [];
  const cmsCandidates = input.technologies.filter((t) => t.category === 'CMS').map(candidate);
  const frameworkCandidates = input.technologies.filter((t) => t.category === 'JavaScript Frameworks').map(candidate);

  // A legacy or builder CMS needs evidence about the site itself; an asset host alone only shows
  // where files are stored. (No legacy signature uses asset hosts today; this keeps the rule explicit.)
  const frontend = JS_FRONTENDS.map((name) => frameworkCandidates.find((c) => c.name === name)).find(
    (c): c is Candidate => c !== undefined,
  );
  const metaFrontend = frontend && META_FRAMEWORKS.has(frontend.name) ? frontend : null;

  // A legacy CMS that shows only as paths in the page source, on a site rendered by a meta-framework,
  // is not what renders the site: the paths are images or a blog served from that CMS. It is recorded
  // as a secondary system, not as the stack. A cookie, header or generator tag keeps it as the stack.
  const pathOnly = (c: Candidate) => c.ownKinds.length === 1 && c.ownKinds[0] === 'source';
  const legacyAll = cmsCandidates.filter((c) => LEGACY_CMS.has(c.name) && c.ownKinds.length > 0).sort(byStrength);
  const backendOnly = metaFrontend ? legacyAll.filter(pathOnly) : [];
  const legacy = legacyAll.filter((c) => !backendOnly.includes(c));
  const builders = cmsCandidates.filter((c) => BUILDER_CMS.has(c.name) && c.ownKinds.length > 0).sort(byStrength);
  const headless = cmsCandidates.filter((c) => HEADLESS_CMS.has(c.name)).sort(byStrength);
  if (backendOnly.length && metaFrontend) {
    notes.push(
      `${backendOnly.map((c) => c.name).join(', ')} shows only as paths in the page source of a ${metaFrontend.name} site: a back end, blog or image store, not the system that renders the site`,
    );
  }

  let kind: StackKind;
  let primary: Candidate | null = null;
  let secondary: Candidate | null = null;

  if (legacy.length) {
    primary = legacy[0];
    if (headless.length) {
      kind = 'hybrid';
      secondary = headless[0];
    } else {
      kind = 'legacy';
    }
    if (legacy.length > 1) {
      if (byStrength(legacy[0], legacy[1]) === 0) {
        notes.push(`Two legacy CMSs with equal evidence: ${legacy[0].name}, ${legacy[1].name}`);
      } else {
        notes.push(
          `Weaker signals also match ${legacy
            .slice(1)
            .map((c) => c.name)
            .join(', ')}`,
        );
      }
    }
    if (builders.length) notes.push(`Builder signals also present: ${builders.map((c) => c.name).join(', ')}`);
  } else if (builders.length) {
    kind = 'builder';
    primary = builders[0];
    if (headless.length) secondary = headless[0];
  } else if (headless.length) {
    primary = headless[0];
    secondary = backendOnly[0] ?? headless[1] ?? null;
    if (frontend) {
      kind = 'headless';
    } else {
      kind = 'unknown';
      notes.push(
        `${primary.name} is visible only as ${primary.ownKinds.length ? 'a script' : 'an asset host'} and no JavaScript front end was detected: the site may run another CMS and use ${primary.name} as a file store`,
      );
    }
  } else if (backendOnly.length && metaFrontend) {
    // A meta-framework front end with a legacy CMS behind it: headless in architecture.
    kind = 'headless';
    primary = backendOnly[0];
  } else if (frontend) {
    kind = 'custom';
  } else {
    kind = 'unknown';
  }

  // Confidence: the two-kinds rule, applied to the claim the kind rests on.
  let confidence: StackConfidence = 'low';
  const equalLegacy = legacy.length > 1 && byStrength(legacy[0], legacy[1]) === 0;
  if (primary && !equalLegacy) {
    if (kind === 'headless' && backendOnly.includes(primary)) {
      // The front end is certain; which CMS feeds it rests on paths alone.
      confidence = 'low';
    } else if (kind === 'headless' && frontend && META_FRAMEWORKS.has(frontend.name)) {
      // The claim is the pair "this CMS behind this front end". The CMS's asset host and the front
      // end's own markup are two different kinds of evidence for it. (A plain React or Vue bundle is
      // weaker evidence of a front end, so it does not count here.)
      confidence = new Set([...primary.kinds, ...frontend.kinds]).size >= 2 ? 'high' : 'low';
    } else if (kind === 'headless' || HEADLESS_CMS.has(primary.name)) {
      // For a headless CMS an asset host is a legitimate kind, but it needs a second, different one.
      confidence = primary.kinds.length >= 2 ? 'high' : 'low';
    } else {
      confidence = primary.ownKinds.length >= 2 ? 'high' : 'low';
    }
  } else if (kind === 'custom' && frontend) {
    confidence = frontend.kinds.length >= 2 ? 'high' : 'low';
  }
  if (kind === 'unknown') confidence = 'low';
  if (confidence === 'low' && primary && !equalLegacy) {
    notes.push(`Only one kind of signal for ${primary.name} (${primary.kinds.join(', ') || 'none'})`);
  }

  const variants: FrameworkVariant[] = input.html ? frameworkVariants(input.html) : [];
  const frameworkVersion =
    versionOf(input.versions, frontend?.name ?? null)?.version ??
    variants.find((v) => v.framework === frontend?.name)?.variant ??
    null;

  const signals = [
    ...(primary?.signals ?? []),
    ...(secondary?.signals ?? []),
    ...(frontend && frontend !== primary ? frontend.signals : []),
  ];

  return {
    kind,
    cms: primary?.name ?? null,
    cmsSecondary: secondary?.name ?? null,
    cmsVersion: versionOf(input.versions, primary?.name ?? null)?.version ?? null,
    framework: frontend?.name ?? null,
    frameworkVersion,
    runtime: runtimeLine(input.versions),
    libraries: input.versions
      .filter((v) => LIBRARY_PRODUCTS.has(v.product) && PRODUCTS[v.product]?.role === 'library')
      .map((v) => ({ name: v.label, version: v.version })),
    versions: input.versions,
    eol: eolHits(input.versions, input.today),
    confidence,
    signals,
    notes,
  };
}

/** Migrate: the site is on a stack we would move it off. Optimise: already headless or custom-built. */
export function trackOf(kind: StackKind): Track | null {
  if (kind === 'legacy' || kind === 'hybrid' || kind === 'builder') return 'migrate';
  if (kind === 'headless' || kind === 'custom' || kind === 'unknown') return 'optimise';
  return null;
}

/** `cookie:set-cookie ~ /…/` → compact `kind:detail` strings for the CSV and `stack.json`. */
export function formatSignals(signals: StackSignal[]): string[] {
  return signals.map((s) => `${s.kind}:${s.tech}:${s.detail}`.slice(0, 120));
}
