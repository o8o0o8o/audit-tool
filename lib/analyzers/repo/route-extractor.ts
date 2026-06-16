/**
 * Route Extractor
 * Extracts defined routes from file-based routing in web frameworks
 */

import * as fs from 'fs';
import * as path from 'path';

interface FrameworkInfo {
  framework: string | null;
  version: string | null;
  packageJson: Record<string, unknown>;
  srcDirs: string[];
  configFile: string | null;
  router: string | null;
}

interface RouteEntry {
  pattern: string;
  file: string;
  isDynamic: boolean;
  [key: string]: unknown;
}

class RouteExtractor {
  /**
   * Extract routes from a repository based on framework
   * @param {string} repoPath - Absolute path to the repository
   * @param {object} frameworkInfo - Output from RepoFrameworkDetector.detect()
   * @returns {Array<{ pattern: string, file: string, isDynamic: boolean }>}
   */
  static extract(repoPath: string, frameworkInfo: FrameworkInfo): RouteEntry[] {
    const { framework, router } = frameworkInfo;

    switch (framework) {
      case 'Next.js':
        return this.#extractNextRoutes(repoPath, router);
      case 'Nuxt':
        return this.#extractNuxtRoutes(repoPath);
      case 'Gatsby':
        return this.#extractGatsbyRoutes(repoPath);
      case 'Astro':
        return this.#extractAstroRoutes(repoPath);
      case 'SvelteKit':
        return this.#extractSvelteKitRoutes(repoPath);
      case 'Remix':
        return this.#extractRemixRoutes(repoPath);
      default:
        return [];
    }
  }

  /**
   * Extract Next.js routes (App Router and/or Pages Router)
   * When both routers are present, deduplicates overlapping route patterns
   */
  static #extractNextRoutes(repoPath: string, router: string | null) {
    const routes: RouteEntry[] = [];

    if (router === 'app' || router === 'both') {
      const appDir = fs.existsSync(path.join(repoPath, 'app')) ? 'app' : 'src/app';
      routes.push(...this.#extractNextAppRoutes(repoPath, appDir));
    }

    if (router === 'pages' || router === 'both') {
      const pagesDir = fs.existsSync(path.join(repoPath, 'pages')) ? 'pages' : 'src/pages';
      const pagesRoutes = this.#extractNextPagesRoutes(repoPath, pagesDir);

      if (router === 'both') {
        // When both routers exist, App Router takes precedence for overlapping patterns
        const appPatterns = new Set(routes.map((r) => r.pattern));
        for (const route of pagesRoutes) {
          if (!appPatterns.has(route.pattern)) {
            routes.push(route);
          }
        }
      } else {
        routes.push(...pagesRoutes);
      }
    }

    return routes;
  }

  /**
   * Extract routes from Next.js App Router (app/ directory)
   * Looks for page.tsx/page.jsx/page.js files
   */
  static #extractNextAppRoutes(repoPath: string, appDir: string) {
    const routes: RouteEntry[] = [];
    const absDir = path.join(repoPath, appDir);
    if (!fs.existsSync(absDir)) return routes;

    const pagePattern = /^page\.(tsx|jsx|js|ts)$/;

    const walk = (dir: string, routePath: string) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip route groups (parentheses), private folders (_), parallel routes (@)
          if (entry.name.startsWith('_')) continue;

          const segment = entry.name;
          // Route groups don't add to URL path
          if (segment.startsWith('(') && segment.endsWith(')')) {
            walk(fullPath, routePath);
            continue;
          }
          // Parallel routes don't add to URL path
          if (segment.startsWith('@')) {
            walk(fullPath, routePath);
            continue;
          }

          walk(fullPath, `${routePath}/${segment}`);
        } else if (pagePattern.test(entry.name)) {
          const relFile = path.relative(repoPath, fullPath);
          const pattern = routePath || '/';
          const isDynamic = /\[/.test(pattern);
          routes.push({ pattern, file: relFile, isDynamic });
        }
      }
    };

    walk(absDir, '');
    // Parallel-route @slots (and other slot-style pages) can yield a page.tsx
    // that resolves to a URL pattern already produced by the main tree. Slots
    // render into a layout slot of an existing URL — they are not navigable
    // URLs of their own — so collapse to one route per pattern.
    return this.#dedupeByPattern(routes);
  }

  /** Keep the first route for each distinct URL pattern, preserving order. */
  static #dedupeByPattern(routes: RouteEntry[]) {
    const seen = new Set<string>();
    return routes.filter((r) => {
      if (seen.has(r.pattern)) return false;
      seen.add(r.pattern);
      return true;
    });
  }

  /**
   * Extract routes from Next.js Pages Router (pages/ directory)
   */
  static #extractNextPagesRoutes(repoPath: string, pagesDir: string) {
    const routes: RouteEntry[] = [];
    const absDir = path.join(repoPath, pagesDir);
    if (!fs.existsSync(absDir)) return routes;

    const pagePattern = /\.(tsx|jsx|js|ts)$/;
    const excludePattern = /^(_app|_document|_error|404|500)\./;
    const apiPattern = /^api$/;

    const walk = (dir: string, routePath: string) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (apiPattern.test(entry.name)) continue; // Skip API routes
          walk(fullPath, `${routePath}/${entry.name}`);
        } else if (pagePattern.test(entry.name) && !excludePattern.test(entry.name)) {
          const relFile = path.relative(repoPath, fullPath);
          const basename = entry.name.replace(pagePattern, '');
          let pattern;
          if (basename === 'index') {
            pattern = routePath || '/';
          } else {
            pattern = `${routePath}/${basename}`;
          }
          const isDynamic = /\[/.test(pattern);
          routes.push({ pattern, file: relFile, isDynamic });
        }
      }
    };

    walk(absDir, '');
    return routes;
  }

  /**
   * Extract Nuxt routes from pages/ directory
   */
  static #extractNuxtRoutes(repoPath: string) {
    const pagesDir = 'pages';
    const absDir = path.join(repoPath, pagesDir);
    if (!fs.existsSync(absDir)) return [];

    const routes: RouteEntry[] = [];
    const pagePattern = /\.(vue|tsx|jsx|js|ts)$/;

    const walk = (dir: string, routePath: string) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          walk(fullPath, `${routePath}/${entry.name}`);
        } else if (pagePattern.test(entry.name)) {
          const relFile = path.relative(repoPath, fullPath);
          const basename = entry.name.replace(pagePattern, '');
          let pattern;
          if (basename === 'index') {
            pattern = routePath || '/';
          } else {
            pattern = `${routePath}/${basename}`;
          }
          // Nuxt uses [...slug] for catch-all, [id] for dynamic
          const isDynamic = /\[/.test(pattern);
          routes.push({ pattern, file: relFile, isDynamic });
        }
      }
    };

    walk(absDir, '');
    return routes;
  }

  /**
   * Extract Gatsby routes from src/pages/
   */
  static #extractGatsbyRoutes(repoPath: string) {
    const pagesDir = 'src/pages';
    const absDir = path.join(repoPath, pagesDir);
    if (!fs.existsSync(absDir)) return [];

    const routes: RouteEntry[] = [];
    const pagePattern = /\.(tsx|jsx|js|ts)$/;

    const walk = (dir: string, routePath: string) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          walk(fullPath, `${routePath}/${entry.name}`);
        } else if (pagePattern.test(entry.name)) {
          const relFile = path.relative(repoPath, fullPath);
          const basename = entry.name.replace(pagePattern, '');
          let pattern;
          if (basename === 'index') {
            pattern = routePath || '/';
          } else {
            pattern = `${routePath}/${basename}`;
          }
          // Gatsby uses {Model.field} for dynamic routes
          const isDynamic = /\{/.test(pattern) || /\[/.test(pattern);
          routes.push({ pattern, file: relFile, isDynamic });
        }
      }
    };

    walk(absDir, '');
    return routes;
  }

  /**
   * Extract Astro routes from src/pages/
   */
  static #extractAstroRoutes(repoPath: string) {
    const pagesDir = 'src/pages';
    const absDir = path.join(repoPath, pagesDir);
    if (!fs.existsSync(absDir)) return [];

    const routes: RouteEntry[] = [];
    const pagePattern = /\.(astro|md|mdx|html|tsx|jsx)$/;

    const walk = (dir: string, routePath: string) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          walk(fullPath, `${routePath}/${entry.name}`);
        } else if (pagePattern.test(entry.name)) {
          const relFile = path.relative(repoPath, fullPath);
          const basename = entry.name.replace(pagePattern, '');
          let pattern;
          if (basename === 'index') {
            pattern = routePath || '/';
          } else {
            pattern = `${routePath}/${basename}`;
          }
          // Astro uses [...slug] and [id] for dynamic
          const isDynamic = /\[/.test(pattern);
          routes.push({ pattern, file: relFile, isDynamic });
        }
      }
    };

    walk(absDir, '');
    return routes;
  }

  /**
   * Extract SvelteKit routes from src/routes/
   */
  static #extractSvelteKitRoutes(repoPath: string) {
    const routesDir = 'src/routes';
    const absDir = path.join(repoPath, routesDir);
    if (!fs.existsSync(absDir)) return [];

    const routes: RouteEntry[] = [];
    const pagePattern = /^\+page\.(svelte|ts|js)$/;

    const walk = (dir: string, routePath: string) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // SvelteKit route groups use (group) syntax
          const segment = entry.name;
          if (segment.startsWith('(') && segment.endsWith(')')) {
            walk(fullPath, routePath);
            continue;
          }
          walk(fullPath, `${routePath}/${segment}`);
        } else if (pagePattern.test(entry.name)) {
          const relFile = path.relative(repoPath, fullPath);
          const pattern = routePath || '/';
          const isDynamic = /\[/.test(pattern);
          routes.push({ pattern, file: relFile, isDynamic });
        }
      }
    };

    walk(absDir, '');
    return routes;
  }

  /**
   * Extract Remix routes from app/routes/
   * Supports both flat routes (v2 convention: blog.$slug.tsx) and nested directories
   */
  static #extractRemixRoutes(repoPath: string) {
    const routesDir = 'app/routes';
    const absDir = path.join(repoPath, routesDir);
    if (!fs.existsSync(absDir)) return [];

    const routes: RouteEntry[] = [];
    const pagePattern = /\.(tsx|jsx|js|ts)$/;

    const walk = (dir: string, pathPrefix: string) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Nested route directory
          const segment = this.#remixSegmentToPattern(entry.name);
          walk(fullPath, `${pathPrefix}/${segment}`);
        } else if (pagePattern.test(entry.name)) {
          const relFile = path.relative(repoPath, fullPath);
          const basename = entry.name.replace(pagePattern, '');

          let pattern;
          if (pathPrefix) {
            // File inside a nested directory
            if (basename === '_index' || basename === 'index') {
              pattern = pathPrefix;
            } else if (basename === 'route') {
              // route.tsx is the default component for a directory route
              pattern = pathPrefix;
            } else {
              // Flat route segments within a directory
              const segments = this.#splitRemixFlat(basename).map((s) => this.#remixSegmentToPattern(s));
              const joined = segments.filter((s) => s).join('/');
              pattern = joined ? `${pathPrefix}/${joined}` : pathPrefix;
            }
          } else {
            // Flat routes at top level: blog.$slug.tsx -> /blog/[slug]
            const segments = this.#splitRemixFlat(basename).map((s) => this.#remixSegmentToPattern(s));
            const joined = segments.filter((s) => s).join('/');
            pattern = '/' + joined;
          }

          if (pattern === '/' || pattern === '') pattern = '/';
          const isDynamic = /\[/.test(pattern);
          routes.push({ pattern, file: relFile, isDynamic });
        }
      }
    };

    walk(absDir, '');
    return routes;
  }

  /**
   * Split a Remix flat-route basename on the `.` segment separator, but NOT on a
   * `.` that sits inside a `[ ]` escape group. In Remix `[ ]` escapes literal
   * characters, so `concerts.trending[.]json` is two segments — `concerts` and
   * `trending[.]json` (a literal `trending.json`) — not four.
   */
  static #splitRemixFlat(basename: string): string[] {
    const out: string[] = [];
    let cur = '';
    let depth = 0;
    for (const ch of basename) {
      if (ch === '[') {
        depth++;
        cur += ch;
      } else if (ch === ']') {
        depth = Math.max(0, depth - 1);
        cur += ch;
      } else if (ch === '.' && depth === 0) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  /**
   * Convert a Remix route segment to a pattern segment
   * $slug -> [slug], _index -> '' (empty), _prefix -> layout (skip),
   * trending[.]json -> trending.json (unwrap `[ ]` literal escapes),
   * $id[.]json -> [id].json (dynamic param + escaped literal suffix in one segment)
   */
  static #remixSegmentToPattern(segment: string) {
    if (segment === '_index' || segment === 'index') return '';
    // $ prefix = dynamic parameter. The param NAME is the leading identifier;
    // anything after it is a literal suffix (with `[ ]` escapes unwrapped), e.g.
    // `$id[.]json` -> `[id]` + `.json`. Without this split the escape would be
    // swallowed into the param name (`[id[.]json]`).
    if (segment.startsWith('$')) {
      const rest = segment.substring(1);
      if (rest === '') return '[...catchall]'; // $ alone = catch-all (splat)
      // Param name = leading identifier run. Unicode letters/digits are allowed
      // (JS/Remix identifiers permit them, e.g. `$слаг`), so the leading run is
      // NOT escaped/escape-bracketed; the `[ ]`-escaped suffix is unwrapped below.
      const m = rest.match(/^([\p{L}\p{N}_]+)([\s\S]*)$/u);
      if (!m) {
        // No leading identifier (e.g. `$[.]json`) — treat the whole rest as literal.
        return this.#unwrapRemixEscapes(rest);
      }
      const param = m[1];
      const suffix = this.#unwrapRemixEscapes(m[2]);
      return `[${param}]${suffix}`;
    }
    // _ prefix = pathless layout route (doesn't add to URL)
    if (segment.startsWith('_')) return '';
    // Literal segment: unwrap `[ ]` escapes (`[.]` -> `.`, `[$]` -> `$`) so an
    // escaped special char becomes the literal it represents, not a stray bracket.
    return this.#unwrapRemixEscapes(segment);
  }

  /** Unwrap Remix `[ ]` literal escapes: `[.]` -> `.`, `[$]` -> `$`. */
  static #unwrapRemixEscapes(s: string): string {
    return s.replace(/\[([^\]]*)\]/g, '$1');
  }
}

export { RouteExtractor };
