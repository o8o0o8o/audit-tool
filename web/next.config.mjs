import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // web/ is its own app; stop Next from picking the repo-root yarn.lock as the workspace root.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // ESLint isn't a dependency of web/; linting runs from the repo root.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
