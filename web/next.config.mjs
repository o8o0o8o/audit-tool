import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // web/ is its own app; stop Next from picking the repo-root yarn.lock as the workspace root.
  outputFileTracingRoot: here,
  // ESLint isn't a dependency of web/; linting runs from the repo root.
  // web/ imports the zod model from the root lib/model/ (alias @model/*); nothing else from the root.
  experimental: { externalDir: true },
  eslint: { ignoreDuringBuilds: true },
  // On Vercel only web/ is installed, and the type check follows imports into root files whose
  // packages are not there (node-html-parser, playwright). Types are checked where the whole repo
  // is installed: `yarn typecheck` at the root and `npx tsc --noEmit` in web/.
  typescript: { ignoreBuildErrors: !!process.env.VERCEL },
  // The root files web/ imports (lib/model/, one file of lib/platform-worker/) take their packages
  // from web/node_modules: on Vercel only web/ is installed, so the root has no node_modules.
  webpack(config) {
    config.resolve.modules = [join(here, 'node_modules'), ...(config.resolve.modules ?? ['node_modules'])];
    return config;
  },
  // Reports are served sandboxed (an opaque origin), so their pages fetch the site fonts cross-origin.
  async headers() {
    return [{ source: '/assets/fonts/:path*', headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }] }];
  },
};

export default nextConfig;
