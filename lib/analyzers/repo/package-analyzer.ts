/**
 * Package.json hygiene analyzer.
 *
 * Covers the package-json checks the human audit PDFs commonly call out:
 *   • Wildcard / unpinned semver ranges (matches realthread audit)
 *   • Multiple CSS-in-JS / styling libraries present in the same project
 *   • Next.js / React major-version mismatch (e.g. Next 13+ needs React 18+)
 *
 * Returns findings in the same { issues, warnings } shape every other
 * repo-analyzer uses, so the orchestrator can splice them straight in.
 */

import type { Issue } from '../../types';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Match unpinned ranges that introduce build non-determinism. */
const WILDCARD_RANGE = /^(\*|latest|x|>=\s*\d|>\s*\d)$/i;

const STYLING_LIBS = ['styled-components', '@emotion/react', '@emotion/styled', 'tailwindcss', 'sass', 'less'];

class PackageAnalyzer {
  static analyze(packageJson: PackageJson): { issues: Issue[]; warnings: Issue[] } {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    const allDeps = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    };

    // 1. Wildcard / unpinned semver ranges
    const wildcards = Object.entries(allDeps).filter(([, range]) => WILDCARD_RANGE.test(range));
    if (wildcards.length > 0) {
      const examples = wildcards
        .slice(0, 5)
        .map(([name, range]) => `<code>${name}: "${range}"</code>`)
        .join(', ');
      warnings.push({
        message: 'Dependencies pinned to wildcard or open-ended ranges',
        detail: `${wildcards.length} dependency range(s) use \`*\` / \`latest\` / open-ended specifiers. This breaks reproducible builds and can pull in breaking changes silently: ${examples}.`,
        severity: 'low',
      });
    }

    // 2. Multiple styling libraries present
    const stylingPresent = STYLING_LIBS.filter((lib) => allDeps[lib] !== undefined);
    if (stylingPresent.length >= 3) {
      warnings.push({
        message: 'Multiple styling solutions in the bundle',
        detail: `Found ${stylingPresent.length} styling libraries co-installed (${stylingPresent.join(', ')}). Each adds runtime + bundle weight; consider consolidating.`,
        severity: 'low',
      });
    }

    // 3. Next.js / React major-version sanity check
    const nextVersion = parseMajor(packageJson.dependencies?.next);
    const reactVersion = parseMajor(packageJson.dependencies?.react);
    if (nextVersion !== null && reactVersion !== null) {
      // Next 13+ requires React 18+; Next 14+ requires React 18+; Next 15 supports React 18 + 19
      if (nextVersion >= 13 && reactVersion < 18) {
        issues.push({
          message: 'Next.js version requires a newer React',
          detail: `Next.js ${nextVersion} requires React 18+, but \`react\` is at version ${reactVersion}. The build will likely fail or behave unpredictably.`,
          severity: 'high',
        });
      }
    }

    // 4. Next.js pre-14 — App Router stabilized in 13.4 but most teams should be on 14+
    if (nextVersion !== null && nextVersion < 14) {
      warnings.push({
        message: `Next.js major version ${nextVersion} is behind the current ecosystem`,
        detail: `App Router improvements (caching, partial prerendering, server actions) landed in Next.js 14+. Plan an upgrade window.`,
        severity: 'low',
      });
    }

    return { issues, warnings };
  }
}

/** Parse the major version out of a semver range like "^14.2.3" → 14. Returns null on failure. */
function parseMajor(range: string | undefined): number | null {
  if (!range) return null;
  const m = range.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export { PackageAnalyzer };
