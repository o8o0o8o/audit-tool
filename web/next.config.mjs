import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // web/ is its own app; stop Next from picking the repo-root yarn.lock as the workspace root.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // ESLint isn't a dependency of web/; linting runs from the repo root.
  // web/ imports the zod model from the root lib/model/ (alias @model/*); nothing else from the root.
  experimental: { externalDir: true },
  eslint: { ignoreDuringBuilds: true },
  // Reports are served sandboxed (an opaque origin), so their pages fetch the site fonts cross-origin.
  async headers() {
    return [{ source: '/assets/fonts/:path*', headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }] }];
  },
};

export default nextConfig;
