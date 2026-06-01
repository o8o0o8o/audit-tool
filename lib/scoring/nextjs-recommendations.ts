/**
 * Next.js-specific fix recommendations.
 *
 * When the audited site is detected as Next.js, the report swaps the generic
 * HTML examples/advice for the idiomatic Next.js equivalent (next/image,
 * next/font, next/script, the Metadata API, next/dynamic, …). These are
 * *overrides* merged over the base FIX_RECOMMENDATIONS entry, so any field not
 * set here (effort, resources) falls back to the generic recommendation.
 *
 * Keyed by the finding message. Matching in the report mirrors the generic
 * lookup (exact → normalized → longest-prefix), so per-page wording variants
 * still resolve.
 */

import type { FixRecommendation } from '../types';
import { normalizeMessage, normalizeMessageForLookup } from '../utils/finding-id';

const NEXT_DOCS = {
  image: { text: 'next/image', url: 'https://nextjs.org/docs/app/api-reference/components/image' },
  font: { text: 'next/font', url: 'https://nextjs.org/docs/app/api-reference/components/font' },
  script: { text: 'next/script', url: 'https://nextjs.org/docs/app/api-reference/components/script' },
  redirects: { text: 'Next.js redirects', url: 'https://nextjs.org/docs/app/api-reference/config/next-config-js/redirects' },
  sitemap: { text: 'Next.js sitemap.ts', url: 'https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap' },
  metadata: { text: 'Metadata API', url: 'https://nextjs.org/docs/app/api-reference/functions/generate-metadata' },
  dynamic: { text: 'next/dynamic (lazy loading)', url: 'https://nextjs.org/docs/app/guides/lazy-loading' },
};

export const NEXTJS_FIX_OVERRIDES: Record<string, Partial<FixRecommendation>> = {
  // ── Images ────────────────────────────────────────────────────────────────
  'Pages serve images only as JPG/PNG instead of WebP/AVIF': {
    fix: 'Render images with the next/image component instead of <img>. It automatically serves AVIF/WebP with fallbacks, resizes per device, and lazy-loads below-the-fold images — no <picture> markup needed.',
    example:
      "import Image from 'next/image';\n\n<Image src=\"/hero.jpg\" alt=\"…\" width={1200} height={630} />\n// Configure formats in next.config.js:\n// images: { formats: ['image/avif', 'image/webp'] }",
    resources: [NEXT_DOCS.image],
  },
  'Pages have image files larger than recommended': {
    fix: 'Serve images through next/image so Next.js resizes and re-encodes them to AVIF/WebP at the requested dimensions. Provide accurate width/height and a sizes prop so the browser fetches an appropriately small variant.',
    example:
      "import Image from 'next/image';\n\n<Image\n  src=\"/photo.jpg\"\n  alt=\"…\"\n  width={800}\n  height={600}\n  sizes=\"(max-width: 768px) 100vw, 800px\"\n/>",
    resources: [NEXT_DOCS.image],
  },
  'Some images are significantly larger than their display size': {
    fix: 'Use next/image with a sizes prop matching the rendered dimensions. Next.js then generates and serves a correctly-sized source instead of shipping the full-resolution file.',
    example: "import Image from 'next/image';\n\n<Image src=\"/photo.jpg\" alt=\"…\" width={400} height={300} sizes=\"400px\" />",
    resources: [NEXT_DOCS.image],
  },
  'LCP image not preloaded': {
    fix: "Add the `priority` prop to the above-the-fold <Image> that is the LCP element — Next.js then preloads it and skips lazy-loading. Never set loading=\"lazy\" on the LCP image.",
    example: "import Image from 'next/image';\n\n<Image src=\"/hero.jpg\" alt=\"…\" width={1200} height={630} priority />",
    resources: [NEXT_DOCS.image],
  },

  // ── Fonts ───────────────────────────────────────────────────────────────────
  'Fonts served in older formats instead of WOFF2': {
    fix: 'Load fonts with next/font (next/font/google or next/font/local). It self-hosts the font as WOFF2, subsets it, and applies font-display automatically — no manual @font-face or preconnect required.',
    example:
      "import { Inter } from 'next/font/google';\n\nconst inter = Inter({ subsets: ['latin'], display: 'swap' });\n\n// app/layout.tsx\nexport default function RootLayout({ children }) {\n  return <html className={inter.className}><body>{children}</body></html>;\n}",
    resources: [NEXT_DOCS.font],
  },
  'Missing font-display property': {
    fix: 'Use next/font, which sets font-display: swap by default so text stays visible while the font loads. Pass `display: \"swap\"` explicitly if configuring manually.',
    example: "import { Inter } from 'next/font/google';\nconst inter = Inter({ subsets: ['latin'], display: 'swap' });",
    resources: [NEXT_DOCS.font],
  },
  'Critical font not preloaded': {
    fix: 'next/font preloads the fonts it manages automatically. Ensure the font is imported in the layout/route that uses it (it preloads per route), rather than via a global CSS @font-face.',
    example: "import { Inter } from 'next/font/google';\nconst inter = Inter({ subsets: ['latin'], preload: true });",
    resources: [NEXT_DOCS.font],
  },
  'Missing preconnect for font services': {
    fix: 'Switch to next/font — it self-hosts Google Fonts at build time, eliminating the runtime request to fonts.googleapis.com/fonts.gstatic.com (so no preconnect is needed at all).',
    example: "import { Inter } from 'next/font/google';\nconst inter = Inter({ subsets: ['latin'] });",
    resources: [NEXT_DOCS.font],
  },

  // ── Third-party scripts ───────────────────────────────────────────────────
  'External scripts missing Subresource Integrity (SRI)': {
    fix: 'Load third-party scripts with the next/script component and a non-blocking strategy (afterInteractive or lazyOnload) so they do not block hydration. For first-party bundles, Next.js adds integrity hashes automatically.',
    example:
      "import Script from 'next/script';\n\n<Script src=\"https://example.com/widget.js\" strategy=\"afterInteractive\" />",
    resources: [NEXT_DOCS.script],
  },
  'Some pages have render-blocking third-party scripts': {
    fix: 'Move third-party tags into next/script with strategy=\"afterInteractive\" (or \"lazyOnload\" for non-critical widgets) so they load after the page is interactive instead of blocking first paint.',
    example: "import Script from 'next/script';\n\n<Script src=\"https://cdn.example.com/analytics.js\" strategy=\"lazyOnload\" />",
    resources: [NEXT_DOCS.script],
  },

  // ── Resource hints / preconnect ─────────────────────────────────────────────
  'Most pages lack resource hints': {
    fix: 'For fonts, next/font adds the needed preconnects automatically. For other critical third-party origins, add <link rel="preconnect"> inside the <head> of app/layout.tsx (App Router).',
    example:
      "// app/layout.tsx\nexport default function RootLayout({ children }) {\n  return (\n    <html>\n      <head>\n        <link rel=\"preconnect\" href=\"https://cdn.example.com\" crossOrigin=\"\" />\n      </head>\n      <body>{children}</body>\n    </html>\n  );\n}",
    resources: [NEXT_DOCS.font],
  },
  'Critical third-party origin lacks preconnect': {
    fix: 'Add a preconnect for the busiest third-party origin in app/layout.tsx <head> (App Router) or via next/head (Pages Router). For Google Fonts, prefer next/font which removes the dependency entirely.',
    example: "// app/layout.tsx <head>\n<link rel=\"preconnect\" href=\"https://www.googletagmanager.com\" crossOrigin=\"\" />",
    resources: [NEXT_DOCS.font],
  },

  // ── Canonical & metadata ────────────────────────────────────────────────────
  "Some loc and canonical don't match": {
    fix: 'Set a self-referential canonical with the Metadata API so each route declares its preferred URL. Use metadataBase + alternates.canonical so the value matches the sitemap entry exactly.',
    example:
      "// app/blog/[slug]/page.tsx\nexport async function generateMetadata({ params }) {\n  return { alternates: { canonical: `/blog/${params.slug}` } };\n}\n// app/layout.tsx — export const metadata = { metadataBase: new URL('https://example.com') };",
    resources: [NEXT_DOCS.metadata],
  },
  'Canonicals are not set for some pages': {
    fix: 'Add alternates.canonical via the Metadata API (or generateMetadata for dynamic routes) so every indexable page is self-referential. Set metadataBase once in the root layout.',
    example:
      "// app/page.tsx\nexport const metadata = { alternates: { canonical: '/' } };\n// app/layout.tsx\nexport const metadata = { metadataBase: new URL('https://example.com') };",
    resources: [NEXT_DOCS.metadata],
  },
  'Some pages are missing canonical URL': {
    fix: 'Add alternates.canonical via the Metadata API so each route is self-referential; set metadataBase in the root layout so relative canonicals resolve to absolute URLs.',
    example: "export const metadata = { alternates: { canonical: '/your-path' } };",
    resources: [NEXT_DOCS.metadata],
  },
  'Duplicate page titles found': {
    fix: 'Give each route a unique title via the Metadata API. Use a title.template in the root layout and per-route titles (or generateMetadata for dynamic routes) so no two pages share a title.',
    example:
      "// app/layout.tsx\nexport const metadata = { title: { template: '%s | Siro', default: 'Siro' } };\n// app/pricing/page.tsx\nexport const metadata = { title: 'Pricing' };",
    resources: [NEXT_DOCS.metadata],
  },
  'Duplicate meta descriptions found': {
    fix: 'Set a unique description per route via the Metadata API. For dynamic routes, derive it in generateMetadata from the page content so each URL gets its own description.',
    example:
      "// app/blog/[slug]/page.tsx\nexport async function generateMetadata({ params }) {\n  const post = await getPost(params.slug);\n  return { description: post.excerpt };\n}",
    resources: [NEXT_DOCS.metadata],
  },

  // ── Bundle / unused code ────────────────────────────────────────────────────
  'Large amount of unused code': {
    fix: 'Keep non-interactive UI as Server Components (the default in the App Router) so it ships zero client JS, and lazy-load heavy client components with next/dynamic so they leave the initial bundle.',
    example: "import dynamic from 'next/dynamic';\n\nconst Heavy = dynamic(() => import('./Heavy'), { ssr: false });",
    resources: [NEXT_DOCS.dynamic],
  },
  'High percentage of unused JavaScript': {
    fix: 'Default to Server Components and only mark interactive leaves with "use client". Lazy-load below-the-fold client components with next/dynamic to trim the initial bundle.',
    example: "import dynamic from 'next/dynamic';\nconst Chart = dynamic(() => import('./Chart'), { ssr: false });",
    resources: [NEXT_DOCS.dynamic],
  },

  // ── Sitemap ───────────────────────────────────────────────────────────────
  'Indexable pages missing from sitemap': {
    fix: "Don't hand-edit sitemap.xml — generate it. Add an app/sitemap.ts that returns every route (static + data-driven) so new pages are always included.",
    example:
      "// app/sitemap.ts\nimport type { MetadataRoute } from 'next';\n\nexport default async function sitemap(): Promise<MetadataRoute.Sitemap> {\n  const posts = await getAllPosts();\n  return [\n    { url: 'https://example.com', lastModified: new Date() },\n    ...posts.map((p) => ({ url: `https://example.com/blog/${p.slug}`, lastModified: p.updatedAt })),\n  ];\n}",
    resources: [NEXT_DOCS.sitemap],
  },
  'Some pages are not listed in sitemap': {
    fix: 'Generate the sitemap from your routes/data in app/sitemap.ts so every indexable page is included automatically — no manual upkeep.',
    example:
      "// app/sitemap.ts\nimport type { MetadataRoute } from 'next';\n\nexport default function sitemap(): MetadataRoute.Sitemap {\n  return routes.map((path) => ({ url: `https://example.com${path}`, lastModified: new Date() }));\n}",
    resources: [NEXT_DOCS.sitemap],
  },
  'Some URLs are not listed in sitemap': {
    fix: 'Generate the sitemap from your routes/data in app/sitemap.ts so discovered pages are included automatically.',
    example:
      "// app/sitemap.ts\nimport type { MetadataRoute } from 'next';\n\nexport default function sitemap(): MetadataRoute.Sitemap {\n  return routes.map((path) => ({ url: `https://example.com${path}`, lastModified: new Date() }));\n}",
    resources: [NEXT_DOCS.sitemap],
  },

  // ── Redirects ───────────────────────────────────────────────────────────────
  'Temporary redirect used instead of permanent': {
    fix: 'Declare moved routes in next.config redirects() with permanent: true (308) so Google passes ranking signals. Reserve temporary redirects (permanent: false) for genuinely short-lived cases.',
    example:
      "// next.config.js\nmodule.exports = {\n  async redirects() {\n    return [{ source: '/old-path', destination: '/new-path', permanent: true }];\n  },\n};",
    resources: [NEXT_DOCS.redirects],
  },
  'Pages sit behind a long redirect chain': {
    fix: 'Collapse multi-hop chains so the original URL redirects straight to the final URL in a single next.config redirects() rule, and update internal <Link href> values to point at the final URL.',
    example:
      "// next.config.js — one hop, not a chain\nmodule.exports = {\n  async redirects() {\n    return [{ source: '/a', destination: '/final', permanent: true }];\n  },\n};",
    resources: [NEXT_DOCS.redirects],
  },
};

// ── Shared matching + detection (used by both the PDF and HTML reports) ───────

const NEXT_BY_NORMAL = buildIndex(normalizeMessage);
const NEXT_BY_LOOKUP = buildIndex(normalizeMessageForLookup);
const NEXT_KEYS_BY_LENGTH = Object.keys(NEXT_BY_LOOKUP).sort((a, b) => b.length - a.length);

function buildIndex(normalize: (s: string) => string): Record<string, Partial<FixRecommendation>> {
  const out: Record<string, Partial<FixRecommendation>> = {};
  for (const [k, v] of Object.entries(NEXTJS_FIX_OVERRIDES)) out[normalize(k)] = v;
  return out;
}

/**
 * The Next.js-specific override for a finding message, matched exact →
 * normalized → longest-prefix (mirroring the generic recommendation lookup).
 */
export function nextjsOverrideFor(message: string): Partial<FixRecommendation> | undefined {
  const exact = NEXT_BY_NORMAL[normalizeMessage(message)] ?? NEXT_BY_LOOKUP[normalizeMessageForLookup(message)];
  if (exact) return exact;
  const lookupForm = normalizeMessageForLookup(message);
  for (const key of NEXT_KEYS_BY_LENGTH) {
    if (key.length < 15) break;
    if (lookupForm === key || lookupForm.startsWith(key + ' ') || lookupForm.startsWith(key + ':')) {
      return NEXT_BY_LOOKUP[key];
    }
  }
  return undefined;
}

/**
 * Whether an audit looks like a Next.js project. Prefers an explicit framework
 * label (from `--repo`); otherwise falls back to the `/_next/` build-output
 * fingerprint that appears in analyzer example strings.
 */
export function isNextjsAudit(
  framework: string | null | undefined,
  detailExamples: Iterable<string>,
): boolean {
  if (/next/i.test(framework ?? '')) return true;
  for (const ex of detailExamples) {
    if (/\/_next\/|__NEXT_DATA__/i.test(ex)) return true;
  }
  return false;
}
