/**
 * CLI Summary
 * Prints a formatted summary of audit results to the console
 */

import type { AnalysisDetail, PageInfo, AuditSummary } from '../types';
import { getLetterGrade, estimateScoreAfterFixes, truncateText } from '../utils';
import { SCORING } from '../constants';

interface AuditResultsExtended {
  analysis: {
    overall?: string[] | Set<string>;
    details?: Record<string, AnalysisDetail>;
    bySeverity?: Record<string, string[]>;
    summary?: Partial<AuditSummary>;
  };
  pageData: {
    pages?: Record<string, PageInfo>;
    total?: number;
    totalWithoutError?: number;
    totalWithError?: number;
    byError?: Record<string, string[] | number>;
    incomingLinks?: Record<string, string[]>;
  };
  sitemaps?: { total?: number };
  robots?: { sitemaps?: string[] };
  timing?: {
    elapsedTimeFormatted?: string;
    phases?: Array<{ name: string; duration: string }>;
  };
  previousScore?: number | null;
}

// ANSI color codes
const C = {
  RED: '\x1b[31m',
  ORANGE: '\x1b[33m',
  YELLOW: '\x1b[93m',
  GREEN: '\x1b[32m',
  BRIGHT_GREEN: '\x1b[92m',
  CYAN: '\x1b[36m',
  BLUE: '\x1b[34m',
  MAGENTA: '\x1b[35m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  RESET: '\x1b[0m',
};

/**
 * Strip ANSI escape codes from a string
 */
function strip(str: string) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Calculate display width of a string in a terminal,
 * accounting for wide characters (emojis, CJK, etc.)
 */
function displayWidth(str: string): number {
  const stripped = strip(str);
  let width = 0;
  for (const char of stripped) {
    const cp = char.codePointAt(0)!;
    if (cp > 0xffff) {
      // Supplementary plane (most emojis) — 2 columns
      width += 2;
    } else if (cp >= 0x2600 && cp <= 0x26ff) {
      // Miscellaneous Symbols (⚡♿☀ etc.) — 2 columns in most terminals
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Pad text to width, accounting for ANSI codes and wide characters
 */
function pad(text: string, width: number) {
  const visible = displayWidth(text);
  if (visible >= width) return text;
  return text + ' '.repeat(width - visible);
}

/**
 * Center text in width, accounting for ANSI codes and wide characters
 */
function center(text: string, width: number) {
  const visible = displayWidth(text);
  const padding = Math.max(0, width - visible);
  const left = Math.floor(padding / 2);
  const right = padding - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

/**
 * Create an ASCII progress bar
 */
function bar(value: number, max: number, width: number = 20) {
  const filled = Math.round((value / max) * width);
  const empty = width - filled;
  let color;
  const pct = (value / max) * 100;
  if (pct >= 80) color = C.GREEN;
  else if (pct >= 60) color = C.YELLOW;
  else if (pct >= 40) color = C.ORANGE;
  else color = C.RED;
  return `${color}${'█'.repeat(filled)}${C.DIM}${'░'.repeat(empty)}${C.RESET}`;
}

const W = 62; // Box width

function line(text: string) {
  console.log('║ ' + pad(text, W - 2) + ' ║');
}

function divider() {
  console.log('╠' + '═'.repeat(W) + '╣');
}

function emptyLine() {
  console.log('║' + ' '.repeat(W) + '║');
}

/**
 * Print audit summary to console
 */
function printAuditSummary(results: AuditResultsExtended, domainName: string, htmlPath: string) {
  const analysis = results.analysis ?? {};
  const summary = analysis.summary ?? {};
  const pageData = results.pageData ?? {};

  const criticalCount = summary.criticalCount ?? 0;
  const highCount = summary.highCount ?? 0;
  const mediumCount = summary.mediumCount ?? 0;
  const lowCount = summary.lowCount ?? 0;
  const totalIssues = summary.totalIssues ?? 0;

  const totalPages = pageData.total ?? Object.keys(pageData.pages ?? {}).length;
  const successPages = pageData.totalWithoutError ?? 0;
  const failedPages = pageData.totalWithError ?? 0;
  const successRate = totalPages > 0 ? ((successPages / totalPages) * 100).toFixed(1) : 0;

  const overallScore = summary.overallScore ?? 0;
  const categoryScores: Record<string, number> = (summary.categoryScores ?? {}) as Record<string, number>;

  const quickWins = getTopQuickWins(analysis, 3);

  console.log('\n');
  console.log('╔' + '═'.repeat(W) + '╗');
  console.log('║' + center(`${C.BOLD}SEO AUDIT SUMMARY${C.RESET}`, W) + '║');
  console.log('║' + center(domainName, W) + '║');
  console.log('╠' + '═'.repeat(W) + '╣');

  // Score gauge with letter grade
  const scoreColor =
    overallScore >= 80 ? C.BRIGHT_GREEN : overallScore >= 60 ? C.GREEN : overallScore >= 40 ? C.ORANGE : C.RED;
  const scoreLabel =
    overallScore >= 90 ? 'Excellent' : overallScore >= 70 ? 'Good' : overallScore >= 50 ? 'Needs Work' : 'Poor';
  const letterGrade = getLetterGrade(overallScore);
  const gauge = bar(overallScore, 100, 30);
  line(
    `${C.BOLD}Score:${C.RESET} ${scoreColor}${C.BOLD}${overallScore}${C.RESET}/100 (${scoreColor}${letterGrade}${C.RESET}) ${scoreColor}${scoreLabel}${C.RESET}`,
  );
  line(`       ${gauge} `);
  emptyLine();

  // Category scores with mini bars
  if (Object.keys(categoryScores).length > 0) {
    line(`${C.BOLD}Categories:${C.RESET}`);
    const categories = [
      { key: 'seo', name: 'SEO', icon: '🔍' },
      { key: 'performance', name: 'Performance', icon: '⚡' },
      { key: 'accessibility', name: 'Accessibility', icon: '♿' },
      { key: 'security', name: 'Security', icon: '🔒' },
      { key: 'technical', name: 'Technical', icon: '🔧' },
    ];
    for (const cat of categories) {
      const score = categoryScores[cat.key] ?? 0;
      const catBar = bar(score, 100, 15);
      const scoreStr = String(score).padStart(3);
      line(`  ${cat.icon} ${cat.name.padEnd(14)} ${catBar} ${scoreStr}/100`);
    }
    emptyLine();
  }

  // Pages
  divider();
  line(`${C.BOLD}Pages:${C.RESET} ${totalPages} crawled`);
  line(`  ${C.GREEN}✓${C.RESET} ${successPages} successful (${successRate}%)`);
  if (failedPages > 0) {
    line(`  ${C.RED}✗${C.RESET} ${failedPages} failed`);
    // Error type breakdown — show array entries (URLs) with their count, skip total_* keys
    const byError = pageData.byError ?? {};
    const errorTypes = Object.entries(byError)
      .filter(([, val]) => Array.isArray(val))
      .map(([key, urls]) => [key, (urls as string[]).length] as [string, number])
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);
    if (errorTypes.length > 0) {
      for (const [errorType, count] of errorTypes) {
        const shortError = truncateText(errorType, W - 12);
        line(`    ${C.DIM}${shortError}: ${count}${C.RESET}`);
      }
    }
  }
  // Sitemap/robots info
  const sitemapTotal = results.sitemaps?.total ?? 0;
  const sitemapCount = results.robots?.sitemaps?.length ?? 0;
  if (sitemapTotal > 0 || sitemapCount > 0) {
    line(`  ${C.CYAN}📋${C.RESET} ${sitemapCount} sitemap(s), ${sitemapTotal} URLs`);
  }
  emptyLine();

  // Issues
  divider();
  line(`${C.BOLD}Issues:${C.RESET} ${totalIssues} total`);
  if (criticalCount > 0) line(`  ${C.RED}■${C.RESET} Critical  ${C.BOLD}${criticalCount}${C.RESET}`);
  if (highCount > 0) line(`  ${C.ORANGE}■${C.RESET} High      ${C.BOLD}${highCount}${C.RESET}`);
  if (mediumCount > 0) line(`  ${C.YELLOW}■${C.RESET} Medium    ${C.BOLD}${mediumCount}${C.RESET}`);
  if (lowCount > 0) line(`  ${C.GREEN}■${C.RESET} Low       ${C.BOLD}${lowCount}${C.RESET}`);

  // Quick wins
  if (quickWins.length > 0) {
    emptyLine();
    divider();
    line(`${C.BOLD}Quick Wins:${C.RESET}`);
    quickWins.forEach((win, i) => {
      const text = `${i + 1}. ${win.title} (${win.count} pages)`;
      line(`  ${C.CYAN}→${C.RESET} ${text.slice(0, W - 6)}`);
    });
  }

  // New insights summary
  const pagesObj = pageData.pages ?? {};
  const pagesArray = Object.values(pagesObj);
  const insightLines = getInsightLines(pagesArray);
  if (insightLines.length > 0) {
    emptyLine();
    divider();
    line(`${C.BOLD}Insights:${C.RESET}`);
    insightLines.forEach((l) => line(`  ${l}`));
  }

  // Top 3 slowest pages (if performance data available)
  const slowestPages = Object.entries(pagesObj)
    .filter(([, p]) => p.TTFB && p.TTFB > 0)
    .sort(([, a], [, b]) => ((b.TTFB as number) ?? 0) - ((a.TTFB as number) ?? 0))
    .slice(0, 3);

  if (slowestPages.length > 0) {
    emptyLine();
    divider();
    line(`${C.BOLD}Slowest Pages (TTFB):${C.RESET}`);
    slowestPages.forEach(([url, p], i: number) => {
      const ttfb = p.TTFB;
      const color = (ttfb ?? 0) > 1500 ? C.RED : (ttfb ?? 0) > 800 ? C.ORANGE : C.GREEN;
      let shortUrl;
      try {
        shortUrl = new URL(url).pathname;
      } catch {
        shortUrl = url;
      }
      if (shortUrl.length > W - 22) shortUrl = '...' + shortUrl.slice(-(W - 25));
      line(`  ${i + 1}. ${color}${ttfb}ms${C.RESET} ${shortUrl}`);
    });
  }

  // Timing
  if (results.timing) {
    emptyLine();
    divider();
    if (results.timing.elapsedTimeFormatted) {
      line(`${C.DIM}Duration: ${results.timing.elapsedTimeFormatted}${C.RESET}`);
    }
    // Phase timing breakdown
    if (results.timing.phases && results.timing.phases.length > 0) {
      for (const phase of results.timing.phases) {
        line(`${C.DIM}  ${phase.name}: ${phase.duration}${C.RESET}`);
      }
    }
  }

  // Score prediction based on category headroom
  if (criticalCount > 0 || highCount > 0) {
    const predicted = estimateScoreAfterFixes(overallScore, categoryScores, SCORING.CATEGORY_WEIGHTS);
    if (predicted) {
      emptyLine();
      divider();
      line(`${C.BOLD}Prediction:${C.RESET} Fix all critical+high issues → ~${C.GREEN}${predicted}${C.RESET}/100`);
    }
  }

  // Previous audit comparison
  if (results.previousScore !== undefined && results.previousScore !== null) {
    emptyLine();
    divider();
    const prev = results.previousScore;
    const delta = overallScore - prev;
    const arrow =
      delta > 0
        ? `${C.GREEN}+${delta} ↑${C.RESET}`
        : delta < 0
          ? `${C.RED}${delta} ↓${C.RESET}`
          : `${C.DIM}±0${C.RESET}`;
    line(`${C.BOLD}vs Previous:${C.RESET} ${prev} → ${overallScore} (${arrow})`);
  }

  // Report path
  emptyLine();
  divider();
  // Truncate path if too long for the box
  const reportLabel = 'Report: ';
  const maxPathLen = W - reportLabel.length - 4;
  const displayPath = htmlPath.length > maxPathLen ? '...' + htmlPath.slice(-(maxPathLen - 3)) : htmlPath;
  line(`${reportLabel}${C.CYAN}${displayPath}${C.RESET}`);

  console.log('╚' + '═'.repeat(W) + '╝');
  console.log('');
}

/**
 * Get top quick wins from analysis
 */
function getTopQuickWins(analysis: AuditResultsExtended['analysis'], count: number) {
  const quickWins: { title: string; count: number }[] = [];
  const details = analysis.details ?? {};

  const issuePatterns = [
    { pattern: /meta description/i, title: 'Missing meta descriptions' },
    { pattern: /title.*missing|missing.*title/i, title: 'Missing page titles' },
    { pattern: /title.*short|short.*title/i, title: 'Title too short' },
    { pattern: /title.*long|long.*title/i, title: 'Title too long' },
    { pattern: /alt.*text|missing.*alt/i, title: 'Missing image alt text' },
    { pattern: /canonical/i, title: 'Canonical URL issues' },
    { pattern: /h1.*missing|missing.*h1/i, title: 'Missing H1 tags' },
    { pattern: /multiple.*h1/i, title: 'Multiple H1 tags' },
    { pattern: /heading.*structure|heading.*hierarchy/i, title: 'Heading structure issues' },
    { pattern: /duplicate.*title/i, title: 'Duplicate titles' },
    { pattern: /duplicate.*description/i, title: 'Duplicate descriptions' },
    { pattern: /broken.*link|404/i, title: 'Broken links' },
    { pattern: /slow.*ttfb|ttfb.*slow/i, title: 'Slow server response' },
    { pattern: /lcp|largest.*contentful/i, title: 'Slow page rendering (LCP)' },
    { pattern: /cls|layout.*shift/i, title: 'Layout shift issues (CLS)' },
  ];

  for (const [issueMessage, pages] of Object.entries(details)) {
    for (const { pattern, title } of issuePatterns) {
      if (pattern.test(issueMessage)) {
        const pageCount = Array.isArray(pages) ? pages.length : 1;
        const existing = quickWins.find((qw) => qw.title === title);
        if (existing) {
          existing.count += pageCount;
        } else {
          quickWins.push({ title, count: pageCount });
        }
        break;
      }
    }
  }

  return quickWins.sort((a, b) => b.count - a.count).slice(0, count);
}

/**
 * Generate JSON summary for --json mode
 */
function getJsonSummary(results: AuditResultsExtended, domainName: string, htmlPath: string) {
  const summary = results.analysis?.summary ?? {};
  const pageData = results.pageData ?? {};
  const totalPages = pageData.total ?? Object.keys(pageData.pages ?? {}).length;

  const score = summary.overallScore ?? 0;
  const grade = getLetterGrade(score);

  return {
    domain: domainName,
    score,
    grade,
    categoryScores: summary.categoryScores ?? {},
    pages: {
      total: totalPages,
      successful: pageData.totalWithoutError ?? 0,
      failed: pageData.totalWithError ?? 0,
    },
    issues: {
      total: summary.totalIssues ?? 0,
      critical: summary.criticalCount ?? 0,
      high: summary.highCount ?? 0,
      medium: summary.mediumCount ?? 0,
      low: summary.lowCount ?? 0,
    },
    duration: results.timing?.elapsedTimeFormatted ?? null,
    report: htmlPath,
    insights: (() => {
      const pArr = Object.values(pageData.pages ?? {}) as PageInfo[];
      if (pArr.length === 0) return undefined;
      return {
        languageMismatches: pArr.filter((p) => p.languageDetection?.match === false).length,
        brokenOutboundLinks: pArr.reduce((s: number, p) => s + (p.outboundLinkHealth?.broken?.length ?? 0), 0),
        nearDuplicatePages: pArr.filter(
          (p) => ((p.contentSimilarity?.similarPages as unknown[] | undefined)?.length ?? 0) > 0,
        ).length,
      };
    })(),
  };
}

/**
 * Build insight summary lines from page data
 */
function getInsightLines(pagesArray: PageInfo[]) {
  const lines: string[] = [];
  if (pagesArray.length === 0) return lines;

  // Language mismatches
  const langMismatches = pagesArray.filter((p) => p.languageDetection?.match === false).length;
  if (langMismatches > 0) {
    lines.push(`${C.ORANGE}⚡${C.RESET} ${langMismatches} page(s) with language mismatch`);
  }

  // Broken outbound links
  const brokenOutbound = pagesArray.reduce((sum, p) => sum + (p.outboundLinkHealth?.broken?.length ?? 0), 0);
  if (brokenOutbound > 0) {
    lines.push(`${C.RED}🔗${C.RESET} ${brokenOutbound} broken outbound link(s)`);
  }

  // Code coverage (avg unused JS/CSS)
  const coveragePages = pagesArray.filter((p) => p.codeCoverage?.js?.ratio != null);
  if (coveragePages.length > 0) {
    const avgUnusedJs = coveragePages.reduce((s, p) => s + (p.codeCoverage?.js?.ratio ?? 0), 0) / coveragePages.length;
    if (avgUnusedJs > 40) {
      lines.push(`${C.YELLOW}📦${C.RESET} Avg ${avgUnusedJs.toFixed(0)}% unused JavaScript`);
    }
  }

  // Near-duplicate / similar content
  const similarPages = pagesArray.filter(
    (p) => ((p.contentSimilarity?.similarPages as unknown[] | undefined)?.length ?? 0) > 0,
  ).length;
  if (similarPages > 0) {
    lines.push(`${C.YELLOW}📄${C.RESET} ${similarPages} page(s) with near-duplicate content`);
  }

  // PageRank highlights (top 3 highest)
  const rankedPages = pagesArray
    .filter((p) => p.internalPageRank != null)
    .sort((a, b) => (b.internalPageRank ?? 0) - (a.internalPageRank ?? 0));
  if (rankedPages.length > 0) {
    const topRank = rankedPages[0].internalPageRank ?? 0;
    const lowRankCount = rankedPages.filter((p) => (p.internalPageRank ?? 0) < topRank * 0.1).length;
    if (lowRankCount > 0) {
      lines.push(`${C.DIM}📊${C.RESET} ${lowRankCount} page(s) with very low internal PageRank`);
    }
  }

  // CTA coverage
  const noCta = pagesArray.filter((p) => p.ctaData?.summary?.total === 0).length;
  if (noCta > 5) {
    lines.push(`${C.DIM}🎯${C.RESET} ${noCta} page(s) have no CTAs`);
  }

  return lines;
}

export { printAuditSummary, getJsonSummary };
export type { AuditResultsExtended };
