/**
 * Repository Framework Detector
 * Detects web framework and version from package.json in a local repository
 */

import * as fs from 'fs';
import * as path from 'path';

class RepoFrameworkDetector {
  // Framework detection rules ordered by specificity (meta-frameworks first)
  static FRAMEWORKS = [
    {
      name: 'Next.js',
      packages: ['next'],
      configFiles: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
      srcDirs: ['app', 'pages', 'src/app', 'src/pages', 'src', 'components', 'lib'],
    },
    {
      name: 'Nuxt',
      packages: ['nuxt', 'nuxt3'],
      configFiles: ['nuxt.config.ts', 'nuxt.config.js'],
      srcDirs: ['pages', 'components', 'layouts', 'composables', 'server', 'src'],
    },
    {
      name: 'Gatsby',
      packages: ['gatsby'],
      configFiles: ['gatsby-config.js', 'gatsby-config.ts'],
      srcDirs: ['src/pages', 'src/templates', 'src/components', 'src'],
    },
    {
      name: 'Astro',
      packages: ['astro'],
      configFiles: ['astro.config.mjs', 'astro.config.ts', 'astro.config.js'],
      srcDirs: ['src/pages', 'src/layouts', 'src/components', 'src'],
    },
    {
      name: 'SvelteKit',
      packages: ['@sveltejs/kit'],
      configFiles: ['svelte.config.js'],
      srcDirs: ['src/routes', 'src/lib', 'src'],
    },
    {
      name: 'Remix',
      packages: ['@remix-run/react', '@remix-run/node'],
      configFiles: ['remix.config.js'],
      srcDirs: ['app', 'app/routes'],
    },
    {
      name: 'React',
      packages: ['react', 'react-dom'],
      configFiles: [],
      srcDirs: ['src', 'src/components', 'src/pages'],
    },
    {
      name: 'Vue',
      packages: ['vue'],
      configFiles: ['vue.config.js', 'vite.config.ts', 'vite.config.js'],
      srcDirs: ['src', 'src/views', 'src/pages', 'src/components'],
    },
    {
      name: 'Angular',
      packages: ['@angular/core'],
      configFiles: ['angular.json'],
      srcDirs: ['src/app', 'src'],
    },
    {
      name: 'Svelte',
      packages: ['svelte'],
      configFiles: [],
      srcDirs: ['src', 'src/routes'],
    },
  ];

  /**
   * Detect the framework used in a repository
   * @param {string} repoPath - Absolute path to the repository
   * @returns {{ framework: string|null, version: string|null, packageJson: object, srcDirs: string[], configFile: string|null, router: string|null }}
   */
  static detect(repoPath: string) {
    const packageJsonPath = path.join(repoPath, 'package.json');
    let packageJson;

    try {
      const content = fs.readFileSync(packageJsonPath, 'utf-8');
      packageJson = JSON.parse(content);
    } catch {
      return { framework: null, version: null, packageJson: {}, srcDirs: ['src'], configFile: null, router: null };
    }

    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    for (const fw of this.FRAMEWORKS) {
      const matchedPkg = fw.packages.find((pkg) => pkg in allDeps);
      if (!matchedPkg) continue;

      const version = allDeps[matchedPkg] ?? null;

      // Find which config file exists
      let configFile = null;
      for (const cf of fw.configFiles) {
        if (fs.existsSync(path.join(repoPath, cf))) {
          configFile = cf;
          break;
        }
      }

      // Filter srcDirs to only those that exist
      const existingSrcDirs = fw.srcDirs.filter((dir) => fs.existsSync(path.join(repoPath, dir)));

      // Detect router type for Next.js
      let router = null;
      if (fw.name === 'Next.js') {
        router = this.#detectNextRouter(repoPath);
      }

      return {
        framework: fw.name,
        version: this.#cleanVersion(version),
        packageJson,
        srcDirs: existingSrcDirs.length > 0 ? existingSrcDirs : ['src'],
        configFile,
        router,
      };
    }

    return { framework: null, version: null, packageJson, srcDirs: ['src'], configFile: null, router: null };
  }

  /**
   * Detect Next.js router type (App Router vs Pages Router)
   * Verifies directories contain actual route files, not just any directory named "app" or "pages"
   * @param {string} repoPath
   * @returns {'app'|'pages'|'both'|null}
   */
  static #detectNextRouter(repoPath: string) {
    const hasApp =
      this.#isAppRouterDir(path.join(repoPath, 'app')) || this.#isAppRouterDir(path.join(repoPath, 'src/app'));
    const hasPages =
      this.#isPagesRouterDir(path.join(repoPath, 'pages')) || this.#isPagesRouterDir(path.join(repoPath, 'src/pages'));

    if (hasApp && hasPages) return 'both';
    if (hasApp) return 'app';
    if (hasPages) return 'pages';
    return null;
  }

  /**
   * Check if directory is a valid Next.js App Router directory
   * Must contain layout.tsx/jsx/js or at least one page.tsx/jsx/js
   */
  static #isAppRouterDir(dir: string) {
    if (!fs.existsSync(dir)) return false;
    try {
      const entries = fs.readdirSync(dir);
      // App Router requires a root layout file, or at least page files
      const hasLayout = entries.some((e) => /^layout\.(tsx|jsx|js|ts)$/.test(e));
      const hasPage = entries.some((e) => /^page\.(tsx|jsx|js|ts)$/.test(e));
      return hasLayout || hasPage;
    } catch {
      return false;
    }
  }

  /**
   * Check if directory is a valid Next.js Pages Router directory
   * Must contain at least one page file (index, _app, or any .tsx/.jsx)
   */
  static #isPagesRouterDir(dir: string) {
    if (!fs.existsSync(dir)) return false;
    try {
      const entries = fs.readdirSync(dir);
      return entries.some((e) => /\.(tsx|jsx|js|ts)$/.test(e) && !e.startsWith('.'));
    } catch {
      return false;
    }
  }

  /**
   * Clean version string (remove ^ ~ >= etc.)
   * @param {string} version
   * @returns {string|null}
   */
  static #cleanVersion(version: string | null) {
    if (!version) return null;
    return version.replace(/^[^0-9]*/, '') || version;
  }
}

export { RepoFrameworkDetector };
