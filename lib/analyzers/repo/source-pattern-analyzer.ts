/**
 * Source-pattern anti-pattern scanner.
 *
 * Walks the framework's source directories and grep-scans for the Next.js /
 * React anti-patterns the human audit PDFs frequently call out:
 *
 *   • `cache: "no-store"` in fetch options — disables Next.js data cache.
 *   • Dynamic imports of main content with `ssr: false` — forces CSR for SEO-
 *     critical content (matches the realthread audit's "react-wrap-balancer" call-out).
 *   • `export const dynamic = 'force-dynamic'` on routes that look static —
 *     matches the unive.nl call-out about `force-dynamic` on static assets.
 *   • Full-lib lodash imports (`import _ from 'lodash'`) — pulls the entire
 *     bundle into the build (matches the Mighty Shed call-out).
 *   • CSS inlined in `_app.tsx` via `dangerouslySetInnerHTML` — matches the
 *     unive.nl call-out about critical CSS placement.
 *
 * Pure regex / fs walk — no AST parsing. Bounded scan: skips node_modules,
 * .next, .git, and caps total files visited.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Issue } from '../../types';

interface FrameworkInfo {
  framework: string | null;
  srcDirs: string[];
}

interface PatternFinding {
  file: string;
  line: number;
  snippet: string;
}

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.cache', '.turbo', '.vercel', 'coverage']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const MAX_FILES = 5000;

const PATTERNS: Array<{
  id: string;
  regex: RegExp;
  message: string;
  detail: (findings: PatternFinding[]) => string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  scopeToFiles?: RegExp; // only fire when matched file path matches
}> = [
  {
    id: 'no-store-cache',
    regex: /cache\s*:\s*['"]no-store['"]/g,
    message: 'fetch() calls disable the Next.js data cache',
    detail: (f) =>
      `Found <code>cache: "no-store"</code> on ${f.length} fetch call(s). This bypasses Next.js's data cache and forces network on every request. Prefer the default cache + \`revalidateTag()\` for invalidation, or \`revalidate: N\` for time-based refresh.`,
    severity: 'medium',
  },
  {
    // Non-greedy match across up to ~200 chars to skip past the import callback
    // (e.g. `() => import('...')`) and reach the options object. Bounded so we
    // don't accidentally span unrelated calls.
    id: 'ssr-false-dynamic',
    regex: /dynamic\s*\([\s\S]{0,200}?\bssr\s*:\s*false\b/g,
    message: 'Dynamic imports with ssr: false break SEO',
    detail: (f) =>
      `${f.length} dynamic import(s) explicitly disable SSR. Search engines and the initial paint see no content — only use \`ssr: false\` for client-only widgets, never for main page content.`,
    severity: 'high',
  },
  {
    id: 'force-dynamic-export',
    regex: /export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/g,
    message: "Routes export `dynamic = 'force-dynamic'`",
    detail: (f) =>
      `${f.length} route file(s) opt into \`force-dynamic\`, which disables all caching. Verify each is actually dynamic — static asset / metadata routes (apple-touch-icon, sitemap, robots) should usually be cached.`,
    severity: 'medium',
  },
  {
    id: 'full-lodash-import',
    regex: /import\s+(?:_|\*\s+as\s+_)\s+from\s+['"]lodash['"]/g,
    message: 'lodash imported as a whole library',
    detail: (f) =>
      `${f.length} file(s) import the full lodash library. Each usage pulls the entire bundle. Replace with method-specific imports (e.g. \`import debounce from 'lodash.debounce'\`).`,
    severity: 'medium',
  },
  {
    id: 'css-inline-app',
    regex: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*fs\.readFileSync\([^}]*\.css/g,
    message: 'CSS inlined via dangerouslySetInnerHTML in _app',
    detail: (f) =>
      `${f.length} occurrence(s) of CSS being read from disk and inlined in a component. If this is critical-CSS extraction it belongs in \`_document.tsx\` (which runs at build time), not \`_app.tsx\` (which runs on each request).`,
    severity: 'low',
    scopeToFiles: /_app\.(t|j)sx?$/,
  },
];

class SourcePatternAnalyzer {
  static analyze(repoPath: string, framework: FrameworkInfo): { issues: Issue[]; warnings: Issue[] } {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    // Only Next.js for now — the patterns above are Next-specific. Other
    // frameworks can be added when we have human-report data showing their
    // common anti-patterns.
    if (framework.framework !== 'nextjs') {
      return { issues, warnings };
    }

    const findings: Record<string, PatternFinding[]> = {};
    for (const p of PATTERNS) findings[p.id] = [];

    let filesVisited = 0;
    const visit = (dir: string): void => {
      if (filesVisited >= MAX_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (filesVisited >= MAX_FILES) return;
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full);
        } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
          filesVisited++;
          let content: string;
          try {
            content = fs.readFileSync(full, 'utf8');
          } catch {
            continue;
          }
          for (const pattern of PATTERNS) {
            if (pattern.scopeToFiles && !pattern.scopeToFiles.test(full)) continue;
            for (const match of content.matchAll(pattern.regex)) {
              const line = content.slice(0, match.index ?? 0).split('\n').length;
              const snippet = match[0].length > 100 ? match[0].slice(0, 100) + '…' : match[0];
              findings[pattern.id].push({
                file: path.relative(repoPath, full),
                line,
                snippet,
              });
            }
          }
        }
      }
    };

    // Resolve repo-relative srcDirs to absolute paths and only visit ones that exist.
    for (const rel of framework.srcDirs) {
      const abs = path.join(repoPath, rel);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        visit(abs);
      }
    }

    // Emit one issue per pattern that found anything
    for (const pattern of PATTERNS) {
      const f = findings[pattern.id];
      if (f.length === 0) continue;

      const examples = f
        .slice(0, 5)
        .map((x) => `<code>${x.file}:${x.line}</code>`)
        .join(', ');
      const detail = `${pattern.detail(f)} Examples: ${examples}.`;

      const issue: Issue = {
        message: pattern.message,
        detail,
        severity: pattern.severity,
      };
      if (pattern.severity === 'critical' || pattern.severity === 'high') {
        issues.push(issue);
      } else {
        warnings.push(issue);
      }
    }

    return { issues, warnings };
  }
}

export { SourcePatternAnalyzer };
