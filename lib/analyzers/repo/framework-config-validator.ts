/**
 * Framework Config Validator
 * Validates SEO-relevant configuration for detected frameworks
 */

import * as fs from 'fs';
import * as path from 'path';
import { SEVERITY } from '../../constants';

class FrameworkConfigValidator {
  /**
   * Validate framework-specific SEO configuration
   * @param {string} repoPath - Absolute path to the repository
   * @param {object} frameworkInfo - Output from RepoFrameworkDetector.detect()
   * @returns {{ issues: Array, warnings: Array }}
   */
  static validate(repoPath: string, frameworkInfo: any) {
    const { framework } = frameworkInfo;

    switch (framework) {
      case 'Next.js':
        return this.#validateNextJs(repoPath, frameworkInfo);
      case 'Nuxt':
        return this.#validateNuxt(repoPath, frameworkInfo);
      case 'Gatsby':
        return this.#validateGatsby(repoPath, frameworkInfo);
      case 'Astro':
        return this.#validateAstro(repoPath, frameworkInfo);
      default:
        return this.#validateGeneric(repoPath);
    }
  }

  /**
   * Validate Next.js SEO configuration
   */
  static #validateNextJs(repoPath: string, frameworkInfo: any) {
    const issues: any[] = [];
    const warnings: any[] = [];
    const { router, configFile } = frameworkInfo;

    // Check next.config
    if (configFile) {
      const configContent = this.#readFile(repoPath, configFile);
      if (configContent) {
        // Check for trailingSlash - look for it as a config key, not just any mention
        if (!this.#hasConfigKey(configContent, 'trailingSlash')) {
          warnings.push({
            message: 'Next.js config missing trailingSlash setting',
            detail: `<code>${configFile}</code> does not explicitly set <code>trailingSlash</code>. This can cause URL inconsistencies. Consider setting it explicitly.`,
            severity: SEVERITY.LOW,
          });
        }

        // Check for image optimization config - look for images as a config object key
        if (!this.#hasConfigKey(configContent, 'images')) {
          warnings.push({
            message: 'Next.js config missing images configuration',
            detail: `<code>${configFile}</code> does not configure <code>images</code>. Consider setting <code>images.formats</code> to include <code>['image/avif', 'image/webp']</code> for better performance.`,
            severity: SEVERITY.LOW,
          });
        }
      }
    } else {
      warnings.push({
        message: 'No Next.js config file found',
        detail: 'No <code>next.config.js</code> or <code>next.config.mjs</code> found. Default configuration will be used.',
        severity: SEVERITY.LOW,
      });
    }

    // App Router specific checks
    if (router === 'app' || router === 'both') {
      const appDir = fs.existsSync(path.join(repoPath, 'app', 'layout.tsx')) ||
                     fs.existsSync(path.join(repoPath, 'app', 'layout.js')) ||
                     fs.existsSync(path.join(repoPath, 'app', 'page.tsx'))
        ? 'app' : 'src/app';

      // Check for robots.ts
      if (!this.#fileExists(repoPath, appDir, 'robots.ts') &&
          !this.#fileExists(repoPath, appDir, 'robots.js')) {
        issues.push({
          message: 'Missing robots.ts in Next.js App Router',
          detail: `No <code>${appDir}/robots.ts</code> found. Create one to programmatically generate robots.txt.`,
          severity: SEVERITY.MEDIUM,
        });
      }

      // Check for sitemap.ts
      if (!this.#fileExists(repoPath, appDir, 'sitemap.ts') &&
          !this.#fileExists(repoPath, appDir, 'sitemap.js') &&
          !this.#fileExists(repoPath, appDir, 'sitemap.xml')) {
        issues.push({
          message: 'Missing sitemap.ts in Next.js App Router',
          detail: `No <code>${appDir}/sitemap.ts</code> found. Create one to programmatically generate your sitemap.`,
          severity: SEVERITY.MEDIUM,
        });
      }

      // Check root layout for metadata export
      const layoutFile = this.#findFile(repoPath, appDir, ['layout.tsx', 'layout.jsx', 'layout.js']);
      if (layoutFile) {
        const layoutContent = this.#readFile(repoPath, layoutFile);
        if (layoutContent && !this.#hasMetadataExport(layoutContent)) {
          issues.push({
            message: 'Root layout missing metadata export',
            detail: `<code>${layoutFile}</code> does not export <code>metadata</code> or <code>generateMetadata</code>. This is required for default page titles and descriptions.`,
            severity: SEVERITY.HIGH,
          });
        }
      }

      // Check for generateMetadata usage in page files
      const pageFiles = this.#findFilesRecursive(repoPath, appDir, /^page\.(tsx|jsx|js)$/);
      let pagesWithMetadata = 0;
      for (const pf of pageFiles) {
        const content = this.#readFile(repoPath, pf);
        if (content && this.#hasMetadataExport(content)) {
          pagesWithMetadata++;
        }
      }
      if (pageFiles.length > 1 && pagesWithMetadata === 0) {
        warnings.push({
          message: 'No page files export metadata',
          detail: `Found ${pageFiles.length} page files in <code>${appDir}/</code> but none export <code>metadata</code> or <code>generateMetadata</code>. Pages will use only the root layout metadata.`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Check for next/image usage vs plain <img> in JSX/TSX files only
    const jsxPattern = /\.(tsx|jsx)$/;
    const imgFiles = this.#searchInSrcDirs(repoPath, frameworkInfo.srcDirs, /<img\s+[^>]*/, jsxPattern);
    const nextImageImports = this.#searchInSrcDirs(repoPath, frameworkInfo.srcDirs, /from\s+['"]next\/image['"]/, jsxPattern);
    if (imgFiles.length > 0 && nextImageImports.length === 0) {
      issues.push({
        message: 'Using plain <img> tags instead of next/image',
        detail: `Found ${imgFiles.length} JSX/TSX file(s) using <code>&lt;img&gt;</code> tags but no imports of <code>next/image</code>. Use the Next.js Image component for automatic optimization. Files: ${imgFiles.slice(0, 3).map(f => `<code>${f}</code>`).join(', ')}${imgFiles.length > 3 ? ` and ${imgFiles.length - 3} more` : ''}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings };
  }

  /**
   * Validate Nuxt SEO configuration
   */
  static #validateNuxt(repoPath: string, frameworkInfo: any) {
    const issues: any[] = [];
    const warnings: any[] = [];
    const { configFile } = frameworkInfo;

    if (configFile) {
      const configContent = this.#readFile(repoPath, configFile);
      if (configContent) {
        // Check for app.head configuration - look for actual config patterns
        const hasAppHead = /app\s*:\s*\{[\s\S]*?head\s*:/m.test(configContent) ||
                           /app\s*:\s*\{[\s\S]*?head\s*\(/m.test(configContent) ||
                           this.#hasConfigKey(configContent, 'head');
        if (!hasAppHead) {
          warnings.push({
            message: 'Nuxt config missing app.head configuration',
            detail: `<code>${configFile}</code> does not configure <code>app.head</code> for default meta tags.`,
            severity: SEVERITY.MEDIUM,
          });
        }

        // Check for SEO module in modules array
        const hasNuxtSEO = /@nuxtjs\/seo/.test(configContent) ||
                           /nuxt-seo-kit/.test(configContent) ||
                           /nuxt-simple-sitemap/.test(configContent) ||
                           /@nuxtjs\/sitemap/.test(configContent);
        if (!hasNuxtSEO) {
          warnings.push({
            message: 'No Nuxt SEO module detected',
            detail: 'Consider adding <code>@nuxtjs/seo</code> or <code>nuxt-simple-sitemap</code> for automatic sitemap and SEO meta generation.',
            severity: SEVERITY.LOW,
          });
        }
      }
    }

    // Check for useHead/useSeoMeta usage in Vue/TS files
    const vuePattern = /\.(vue|ts|js)$/;
    const useHeadFiles = this.#searchInSrcDirs(repoPath, frameworkInfo.srcDirs, /useHead\s*\(/, vuePattern);
    const useSeoMetaFiles = this.#searchInSrcDirs(repoPath, frameworkInfo.srcDirs, /useSeoMeta\s*\(/, vuePattern);
    if (useHeadFiles.length === 0 && useSeoMetaFiles.length === 0) {
      warnings.push({
        message: 'No useHead or useSeoMeta usage found',
        detail: 'No files use <code>useHead()</code> or <code>useSeoMeta()</code> for dynamic meta tags. Consider using these composables for per-page SEO.',
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check for NuxtImg usage vs plain <img> in Vue templates
    const imgUsage = this.#searchInSrcDirs(repoPath, frameworkInfo.srcDirs, /<img\s+[^>]*/, /\.vue$/);
    const nuxtImgUsage = this.#searchInSrcDirs(repoPath, frameworkInfo.srcDirs, /<NuxtImg|<nuxt-img/, /\.vue$/);
    if (imgUsage.length > 0 && nuxtImgUsage.length === 0) {
      warnings.push({
        message: 'Using plain <img> tags instead of NuxtImg',
        detail: `Found ${imgUsage.length} Vue file(s) using <code>&lt;img&gt;</code>. Consider using <code>&lt;NuxtImg&gt;</code> from <code>@nuxt/image</code> for automatic optimization.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings };
  }

  /**
   * Validate Gatsby SEO configuration
   */
  static #validateGatsby(repoPath: string, frameworkInfo: any) {
    const issues: any[] = [];
    const warnings: any[] = [];
    const { configFile } = frameworkInfo;

    if (configFile) {
      const configContent = this.#readFile(repoPath, configFile);
      if (configContent) {
        if (!configContent.includes('gatsby-plugin-sitemap')) {
          issues.push({
            message: 'Missing gatsby-plugin-sitemap',
            detail: `<code>${configFile}</code> does not include <code>gatsby-plugin-sitemap</code>. Add it to automatically generate a sitemap.`,
            severity: SEVERITY.MEDIUM,
          });
        }

        if (!configContent.includes('gatsby-plugin-robots-txt')) {
          warnings.push({
            message: 'Missing gatsby-plugin-robots-txt',
            detail: 'Consider adding <code>gatsby-plugin-robots-txt</code> for automatic robots.txt generation.',
            severity: SEVERITY.LOW,
          });
        }

        // Check for head management - Gatsby 4.19+ has Head API built-in
        const hasHeadManagement = configContent.includes('gatsby-plugin-react-helmet') ||
                                   configContent.includes('react-helmet');
        // Also check if using Gatsby Head API in page files
        const jsxPattern = /\.(tsx|jsx|js)$/;
        const headExports = this.#searchInSrcDirs(repoPath, ['src/pages', 'src/templates'], /export\s+(const|function)\s+Head\b/, jsxPattern);

        if (!hasHeadManagement && headExports.length === 0) {
          warnings.push({
            message: 'No head management strategy detected',
            detail: 'No <code>gatsby-plugin-react-helmet</code> or Gatsby Head API exports found. Ensure you have a strategy for managing meta tags.',
            severity: SEVERITY.MEDIUM,
          });
        }
      }
    }

    // Check for gatsby-ssr.js
    if (!fs.existsSync(path.join(repoPath, 'gatsby-ssr.js')) &&
        !fs.existsSync(path.join(repoPath, 'gatsby-ssr.ts'))) {
      warnings.push({
        message: 'No gatsby-ssr.js found',
        detail: 'Consider creating <code>gatsby-ssr.js</code> to inject global meta tags or structured data during server-side rendering.',
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings };
  }

  /**
   * Validate Astro SEO configuration
   */
  static #validateAstro(repoPath: string, frameworkInfo: any) {
    const issues: any[] = [];
    const warnings: any[] = [];
    const { configFile } = frameworkInfo;

    if (configFile) {
      const configContent = this.#readFile(repoPath, configFile);
      if (configContent) {
        // Check for sitemap integration - look for the package reference
        if (!/@astrojs\/sitemap/.test(configContent)) {
          issues.push({
            message: 'Missing @astrojs/sitemap integration',
            detail: `<code>${configFile}</code> does not include the sitemap integration. Add <code>@astrojs/sitemap</code> to automatically generate a sitemap.`,
            severity: SEVERITY.MEDIUM,
          });
        }
      }
    }

    // Check layout files for <head> with dynamic meta tags
    const layoutDir = path.join(repoPath, 'src/layouts');
    if (fs.existsSync(layoutDir)) {
      const layoutFiles = this.#findFilesRecursive(repoPath, 'src/layouts', /\.astro$/);
      let hasHeadMeta = false;
      for (const lf of layoutFiles) {
        const content = this.#readFile(repoPath, lf);
        if (!content) continue;
        // Look for <head> containing dynamic title or meta from props/frontmatter
        const hasHead = /<head[\s>]/.test(content);
        const hasDynamicTitle = /<title>.*\{/.test(content) || /Astro\.props/.test(content) || /\{.*title.*\}/.test(content);
        if (hasHead && hasDynamicTitle) {
          hasHeadMeta = true;
          break;
        }
      }
      if (!hasHeadMeta && layoutFiles.length > 0) {
        warnings.push({
          message: 'Layout files may lack dynamic meta tags',
          detail: 'Layout files in <code>src/layouts/</code> do not appear to have dynamic <code>&lt;title&gt;</code> or meta tags from props.',
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    return { issues, warnings };
  }

  /**
   * Generic validation for unrecognized frameworks
   */
  static #validateGeneric(repoPath: string) {
    const issues: any[] = [];
    const warnings: any[] = [];

    // Check for robots.txt
    if (!fs.existsSync(path.join(repoPath, 'public/robots.txt')) &&
        !fs.existsSync(path.join(repoPath, 'static/robots.txt'))) {
      warnings.push({
        message: 'No robots.txt found in public/static directory',
        detail: 'No <code>robots.txt</code> found in <code>public/</code> or <code>static/</code>. Ensure one is generated during build.',
        severity: SEVERITY.LOW,
      });
    }

    // Check for sitemap
    if (!fs.existsSync(path.join(repoPath, 'public/sitemap.xml')) &&
        !fs.existsSync(path.join(repoPath, 'static/sitemap.xml'))) {
      warnings.push({
        message: 'No sitemap.xml found in public/static directory',
        detail: 'No static <code>sitemap.xml</code> found. Ensure a sitemap is generated during build or served dynamically.',
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings };
  }

  // --- Helper methods ---

  static #readFile(repoPath: string, relativePath: string) {
    try {
      return fs.readFileSync(path.join(repoPath, relativePath), 'utf-8');
    } catch {
      return null;
    }
  }

  static #fileExists(repoPath: string, dir: string, filename: string) {
    return fs.existsSync(path.join(repoPath, dir, filename));
  }

  static #findFile(repoPath: string, dir: string, filenames: string[]) {
    for (const name of filenames) {
      const fullPath = path.join(dir, name);
      if (fs.existsSync(path.join(repoPath, fullPath))) {
        return fullPath;
      }
    }
    return null;
  }

  /**
   * Check if a JS/TS config file has a specific key as a property (not in comments/strings)
   * Matches patterns like: key:, key :, "key":, 'key':
   * @param {string} content - File content
   * @param {string} key - Config key name
   * @returns {boolean}
   */
  static #hasConfigKey(content: string, key: string) {
    // Strip single-line comments to avoid false positives
    const stripped = content.replace(/\/\/.*$/gm, '');
    // Match as object key: key:, "key":, 'key':
    const keyPattern = new RegExp(`(?:^|[{,\\s])['"]?${key}['"]?\\s*:`, 'm');
    return keyPattern.test(stripped);
  }

  /**
   * Check if a Next.js file exports metadata or generateMetadata
   * More specific than just string.includes('metadata') to avoid false positives
   * @param {string} content - File content
   * @returns {boolean}
   */
  static #hasMetadataExport(content: string) {
    // export const metadata
    if (/export\s+(const|let|var)\s+metadata\b/.test(content)) return true;
    // export async function generateMetadata
    if (/export\s+(async\s+)?function\s+generateMetadata\b/.test(content)) return true;
    // export { metadata } or export { generateMetadata }
    if (/export\s*\{[^}]*\bmetadata\b[^}]*\}/.test(content)) return true;
    if (/export\s*\{[^}]*\bgenerateMetadata\b[^}]*\}/.test(content)) return true;
    return false;
  }

  /**
   * Recursively find files matching a filename pattern within a directory
   * @param {string} repoPath
   * @param {string} dir - Relative directory
   * @param {RegExp} pattern - Filename pattern
   * @param {number} maxDepth - Maximum recursion depth
   * @returns {string[]} Relative file paths
   */
  static #findFilesRecursive(repoPath: string, dir: string, pattern: RegExp, maxDepth = 10) {
    const results: any[] = [];
    const absDir = path.join(repoPath, dir);

    if (!fs.existsSync(absDir)) return results;

    const walk = (currentDir: string, depth: number) => {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (pattern.test(entry.name)) {
          results.push(path.relative(repoPath, fullPath));
        }
      }
    };

    walk(absDir, 0);
    return results;
  }

  /**
   * Search for a content pattern in source directories, return files that match
   * @param {string} repoPath
   * @param {string[]} srcDirs
   * @param {RegExp} contentPattern - Pattern to search for in file content
   * @param {RegExp} filePattern - Pattern to filter filenames (e.g., /\.(tsx|jsx)$/)
   * @returns {string[]} Matching relative file paths
   */
  static #searchInSrcDirs(repoPath: string, srcDirs: string[], contentPattern: RegExp, filePattern: RegExp) {
    const matches = [];
    const seen = new Set();

    for (const dir of srcDirs) {
      const files = this.#findFilesRecursive(repoPath, dir, filePattern);
      for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);

        const content = this.#readFile(repoPath, file);
        if (content && contentPattern.test(content)) {
          matches.push(file);
        }
      }
    }

    return matches;
  }
}

export { FrameworkConfigValidator };