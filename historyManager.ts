// Enable TypeScript imports via tsx
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import type {
  AuditHistory,
  AuditSnapshot,
  AuditComparison,
  AuditDiffEntry,
  IssueSummary,
  PerformanceSummary,
  InsightsSummary,
  IssueTrend,
  PageInfo,
  AuditResults,
  QuickWinFull,
  SeverityLevel,
} from './lib/types';
import { FileManager } from './lib/storage/file-manager';
import { extractPageInsights } from './lib/reports/data-processor';
import { sanitizeDomainName } from './validators';
import { statAvg, statPercentile } from './lib/utils';
import { slugifyFinding, isVolatileFinding } from './lib/utils/finding-id';

/**
 * Audit History Manager
 * Tracks audit results over time for trend analysis and comparison
 */

class HistoryManager {
  domainName: string;
  baseResultsDir: string;
  domainDir: string;
  historyFile: string;
  historyFileUncompressed: string;
  legacyHistoryDir: string;
  legacyHistoryFile: string;

  constructor(domainName: string, baseResultsDir = 'audit-results') {
    this.domainName = domainName;
    this.baseResultsDir = baseResultsDir;

    // New structure: audit-results/domain.com/audit-history.json.gz (compressed)
    this.domainDir = path.join(this.baseResultsDir, this.domainName);
    this.historyFile = path.join(this.domainDir, 'audit-history.json.gz');
    this.historyFileUncompressed = path.join(this.domainDir, 'audit-history.json');

    // Legacy path for backward compatibility
    this.legacyHistoryDir = '.audit-history';
    this.legacyHistoryFile = path.join(this.legacyHistoryDir, `${domainName}.history.json`);

    this.ensureHistoryDir();
  }

  ensureHistoryDir() {
    if (!fs.existsSync(this.domainDir)) {
      fs.mkdirSync(this.domainDir, { recursive: true });
    }
  }

  loadHistory(): AuditHistory {
    // Try compressed file first
    if (fs.existsSync(this.historyFile)) {
      try {
        return FileManager.readJsonFile(this.historyFile);
      } catch (error: unknown) {
        console.error(`Error loading compressed history: ${(error as Error).message}`);
        return { domain: this.domainName, audits: [] };
      }
    }

    // Try uncompressed file (migrate to compressed)
    if (fs.existsSync(this.historyFileUncompressed)) {
      console.log(`📦 Migrating history to compressed format...`);
      try {
        const uncompressedHistory = JSON.parse(fs.readFileSync(this.historyFileUncompressed, 'utf-8'));
        // Save to compressed format
        this.saveHistory(uncompressedHistory);

        // Verify the compressed file was written correctly before deleting old file
        if (fs.existsSync(this.historyFile)) {
          try {
            // Verify we can read the compressed file
            const verifyData = FileManager.readJsonFile(this.historyFile);
            if (verifyData?.audits && verifyData.audits.length === uncompressedHistory.audits.length) {
              // Safe to remove old uncompressed file
              try {
                fs.unlinkSync(this.historyFileUncompressed);
                console.log(`✓ History migrated to compressed: ${this.historyFile}`);
              } catch (unlinkError: unknown) {
                console.warn(`⚠️  Could not remove old history file: ${(unlinkError as Error).message}`);
              }
            } else {
              console.warn(`⚠️  Migration verification failed - keeping both files`);
            }
          } catch (verifyError: unknown) {
            console.warn(
              `⚠️  Could not verify compressed file - keeping both files: ${(verifyError as Error).message}`,
            );
          }
        }
        return uncompressedHistory;
      } catch (error: unknown) {
        console.error(`Error migrating uncompressed history: ${(error as Error).message}`);
      }
    }

    // Check legacy location for migration
    if (fs.existsSync(this.legacyHistoryFile)) {
      console.log(`📦 Migrating history from legacy location...`);
      try {
        const legacyHistory = FileManager.readJsonFile(this.legacyHistoryFile);

        // Validate legacy history structure
        if (!legacyHistory || typeof legacyHistory !== 'object') {
          throw new Error('Legacy history file is empty or invalid');
        }
        if (!Array.isArray(legacyHistory.audits)) {
          legacyHistory.audits = [];
        }

        // Save to new compressed location
        this.saveHistory(legacyHistory);
        console.log(`✓ History migrated to: ${this.historyFile}`);
        return legacyHistory;
      } catch (error: unknown) {
        console.error(`Error migrating history: ${(error as Error).message}`);
        console.log(`  ℹ️  Starting with fresh history. Old data preserved at: ${this.legacyHistoryFile}`);
      }
    }

    // No history found - this is normal for first audit
    return { domain: this.domainName, audits: [] };
  }

  saveHistory(history: AuditHistory) {
    // Save as compressed gzip JSON with atomic write (temp file + rename)
    const jsonString = JSON.stringify(history);
    const compressedData = zlib.gzipSync(jsonString);

    // Write to temp file first, then rename for atomic operation
    const tempFile = `${this.historyFile}.tmp`;
    try {
      fs.writeFileSync(tempFile, compressedData);

      // Verify temp file was written correctly
      const stats = fs.statSync(tempFile);
      if (stats.size === 0) {
        throw new Error('Temp file is empty');
      }

      // Atomic rename (on same filesystem, this is atomic)
      fs.renameSync(tempFile, this.historyFile);
    } catch (error) {
      // Clean up temp file if it exists
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  addAuditSnapshot(auditData: Partial<AuditResults>, runTimestamp: string | null = null) {
    const history = this.loadHistory();

    const snapshot = {
      timestamp: new Date().toISOString(),
      date: new Date().toLocaleDateString(),
      runTimestamp: runTimestamp ?? null, // Link to run directory
      summary: {
        overallScore: auditData.analysis?.summary?.overallScore ?? 0,
        totalIssues: auditData.analysis?.summary?.totalIssues ?? 0,
        criticalCount: auditData.analysis?.summary?.criticalCount ?? 0,
        highCount: auditData.analysis?.summary?.highCount ?? 0,
        mediumCount: auditData.analysis?.summary?.mediumCount ?? 0,
        lowCount: auditData.analysis?.summary?.lowCount ?? 0,
        passRate: auditData.analysis?.summary?.passRate ?? 0,
        categoryScores: auditData.analysis?.summary?.categoryScores ?? {},
        totalPages: Object.keys(auditData.pageData?.pages ?? {}).length,
        pagesWithErrors: auditData.pageData?.totalWithError ?? 0,
        sitemapUrls: auditData.sitemaps?.total ?? 0,
      },
      issues: this.extractIssuesSummary(auditData),
      performance: this.extractPerformanceSummary(auditData),
      technologies: this.extractTechnologiesSummary(auditData),
      insights: this.extractInsightsSummary(auditData),
      quickWins: ((auditData.analysis?.summary?.quickWins ?? []) as QuickWinFull[]).map((qw) => ({
        issue: qw.issue,
        affectedPages: qw.affectedPages,
        severity: (qw.severity ?? 'medium') as SeverityLevel,
      })),
      pageHashes: this.#extractPageHashes(auditData),
    };

    history.audits.push(snapshot);
    this.saveHistory(history);

    console.log(`\n📊 Audit snapshot saved to history`);
    console.log(`   Total audits: ${history.audits.length}`);

    return snapshot;
  }

  extractIssuesSummary(auditData: Partial<AuditResults>): Record<string, IssueSummary> {
    const details = auditData.analysis?.details ?? {};
    const summary: Record<string, IssueSummary> = {};

    Object.entries(details).forEach(([issue, data]) => {
      summary[issue] = {
        severity: data.severity,
        count: data.examples?.length ?? 0,
      };
    });

    return summary;
  }

  extractPerformanceSummary(auditData: Partial<AuditResults>): PerformanceSummary | null {
    const pages = auditData.pageData?.pages ?? {};
    const pagesWithPerf = (Object.values(pages) as PageInfo[]).filter((p) => p.vitals ?? p.TTFB);

    if (pagesWithPerf.length === 0) return null;

    const avg = statAvg;
    const p75 = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return statPercentile(sorted, 0.75);
    };

    // Support both old (vitals.ttfb) and new (TTFB) formats
    const ttfbValues = pagesWithPerf.map((p) => p.TTFB ?? (p.vitals?.ttfb as number) ?? 0).filter((v) => v > 0);
    const lcpValues = pagesWithPerf.map((p) => p.LCP ?? (p.vitals?.lcp as number) ?? 0).filter((v) => v > 0);
    // CLS=0 is a perfect score (no layout shift) — don't filter it out
    const clsValues = pagesWithPerf
      .map((p) => p.CLS ?? (p.vitals?.cls as number | undefined) ?? null)
      .filter((v): v is number => v !== null && v !== undefined);

    return {
      avgTTFB: avg(ttfbValues as number[]).toFixed(0),
      avgLCP: avg(lcpValues as number[]).toFixed(0),
      avgCLS: avg(clsValues as number[]).toFixed(3),
      p75TTFB: p75(ttfbValues as number[]).toFixed(0),
      p75LCP: p75(lcpValues as number[]).toFixed(0),
      p75CLS: p75(clsValues as number[]).toFixed(3),
      pagesWithMetrics: pagesWithPerf.length,
    };
  }

  extractInsightsSummary(auditData: Partial<AuditResults>): InsightsSummary | null {
    const pages = Object.values(auditData.pageData?.pages ?? {}) as PageInfo[];
    if (pages.length === 0) return null;
    return extractPageInsights(pages);
  }

  extractTechnologiesSummary(auditData: Partial<AuditResults>): string[] {
    const pages = auditData.pageData?.pages ?? {};
    const allTechs = new Set<string>();

    for (const page of Object.values(pages) as PageInfo[]) {
      const tech = page.technologies;
      const technologies = tech?.technologies ?? [];
      for (const t of technologies) {
        allTechs.add(t.name);
      }
    }

    return Array.from(allTechs);
  }

  getLatestAudit() {
    const history = this.loadHistory();
    return history.audits.length > 0 ? history.audits[history.audits.length - 1] : null;
  }

  getAuditByIndex(index: number) {
    const history = this.loadHistory();
    // Validate index bounds
    if (typeof index !== 'number' || index < 0 || index >= history.audits.length) {
      return null;
    }
    return history.audits[index];
  }

  getAllAudits() {
    const history = this.loadHistory();
    return history.audits;
  }

  compareAudits(oldAudit: AuditSnapshot, newAudit: AuditSnapshot): AuditComparison {
    const comparison: AuditComparison = {
      timestamp: new Date().toISOString(),
      oldDate: oldAudit.date,
      newDate: newAudit.date,
      scoreChange: newAudit.summary.overallScore - oldAudit.summary.overallScore,
      improvements: [],
      regressions: [],
      fixed: [],
      newIssues: [],
      deltaMetrics: {
        totalIssues: newAudit.summary.totalIssues - oldAudit.summary.totalIssues,
        critical: newAudit.summary.criticalCount - oldAudit.summary.criticalCount,
        high: newAudit.summary.highCount - oldAudit.summary.highCount,
        medium: newAudit.summary.mediumCount - oldAudit.summary.mediumCount,
        low: newAudit.summary.lowCount - oldAudit.summary.lowCount,
        passRate: newAudit.summary.passRate - oldAudit.summary.passRate,
      },
    };

    // Compare category scores
    if (oldAudit.summary.categoryScores && newAudit.summary.categoryScores) {
      const deltas: Record<string, number> = {};
      (['seo', 'performance', 'accessibility', 'security', 'technical'] as const).forEach((cat) => {
        const oldScore = oldAudit.summary.categoryScores[cat] ?? 0;
        const newScore = newAudit.summary.categoryScores[cat] ?? 0;
        deltas[cat] = newScore - oldScore;
      });
      comparison.categoryDeltas = deltas;
    }

    // Compare performance metrics
    if (oldAudit.performance && newAudit.performance) {
      comparison.performanceDeltas = {
        ttfb: parseFloat(newAudit.performance.avgTTFB) - parseFloat(oldAudit.performance.avgTTFB),
        lcp: parseFloat(newAudit.performance.avgLCP) - parseFloat(oldAudit.performance.avgLCP),
        cls: parseFloat(newAudit.performance.avgCLS) - parseFloat(oldAudit.performance.avgCLS),
      };
    }

    // Compare insight metrics
    if (oldAudit.insights && newAudit.insights) {
      comparison.insightDeltas = {};
      for (const key of [
        'languageMismatches',
        'brokenOutboundLinks',
        'nearDuplicatePages',
        'pagesWithoutCTAs',
        'avgJsUnused',
        'avgCssUnused',
      ] as const) {
        const oldVal = oldAudit.insights[key];
        const newVal = newAudit.insights[key];
        if (oldVal != null && newVal != null) {
          comparison.insightDeltas[key] = newVal - oldVal;
        }
      }
    }

    // Detect fixed issues and new issues
    const oldIssues = new Set(Object.keys(oldAudit.issues));
    const newIssues = new Set(Object.keys(newAudit.issues));

    oldIssues.forEach((issue) => {
      if (!newIssues.has(issue)) {
        comparison.fixed.push(issue);
        comparison.improvements.push(`Fixed: ${issue}`);
      } else if (oldAudit.issues[issue].count > newAudit.issues[issue].count) {
        const reduction = oldAudit.issues[issue].count - newAudit.issues[issue].count;
        comparison.improvements.push(
          `${issue}: Reduced from ${oldAudit.issues[issue].count} to ${newAudit.issues[issue].count} pages (-${reduction})`,
        );
      } else if (oldAudit.issues[issue].count < newAudit.issues[issue].count) {
        const increase = newAudit.issues[issue].count - oldAudit.issues[issue].count;
        comparison.regressions.push(
          `${issue}: Increased from ${oldAudit.issues[issue].count} to ${newAudit.issues[issue].count} pages (+${increase})`,
        );
      }
    });

    newIssues.forEach((issue) => {
      if (!oldIssues.has(issue)) {
        comparison.newIssues.push(issue);
        comparison.regressions.push(`New issue: ${issue} (${newAudit.issues[issue].count} pages)`);
      }
    });

    // Classifier: build real / noise / siteChanged buckets using stable IDs
    // and the volatile-finding heuristic. This gives the reader a way to tell
    // apart "the site changed" from "the measurement drifted".
    comparison.classified = HistoryManager.#classifyDiff(oldAudit, newAudit);

    return comparison;
  }

  /**
   * Build the three-bucket diff classifier output.
   * @private
   */
  static #classifyDiff(oldAudit: AuditSnapshot, newAudit: AuditSnapshot) {
    // Group old + new issues by stable slug
    const bySlug: Map<string, { slug: string; oldMsg?: string; newMsg?: string; oldCount: number; newCount: number; severity?: string }> = new Map();
    const indexSide = (issues: Record<string, IssueSummary>, side: 'old' | 'new') => {
      for (const [msg, data] of Object.entries(issues ?? {})) {
        const slug = slugifyFinding(msg);
        if (!bySlug.has(slug)) {
          bySlug.set(slug, { slug, oldCount: 0, newCount: 0 });
        }
        const entry = bySlug.get(slug)!;
        // Sum counts across variants that collapse to the same slug
        if (side === 'old') {
          entry.oldCount += data.count ?? 0;
          entry.oldMsg = entry.oldMsg ?? msg;
        } else {
          entry.newCount += data.count ?? 0;
          entry.newMsg = entry.newMsg ?? msg;
        }
        entry.severity = entry.severity ?? data.severity;
      }
    };
    indexSide(oldAudit.issues ?? {}, 'old');
    indexSide(newAudit.issues ?? {}, 'new');

    // Volatile-count noise floor: a volatile finding's count must move >25%
    // (and by ≥2 pages absolute) to count as a real change.
    const isNoise = (entry: { oldCount: number; newCount: number }, volatile: boolean) => {
      if (!volatile) return false;
      const abs = Math.abs(entry.newCount - entry.oldCount);
      const base = Math.max(entry.oldCount, entry.newCount, 1);
      return abs < 2 || abs / base < 0.25;
    };

    const real: AuditDiffEntry[] = [];
    const noise: AuditDiffEntry[] = [];

    for (const entry of bySlug.values()) {
      if (entry.oldCount === entry.newCount) continue; // unchanged → don't list
      const message = entry.newMsg ?? entry.oldMsg ?? entry.slug;
      const volatile = isVolatileFinding(message);
      const kind: AuditDiffEntry['kind'] =
        entry.oldCount === 0 ? 'new' : entry.newCount === 0 ? 'fixed' : 'count';
      const diff: AuditDiffEntry = {
        slug: entry.slug,
        message,
        kind,
        oldCount: entry.oldCount,
        newCount: entry.newCount,
        severity: entry.severity,
        volatile,
      };
      // "new" / "fixed" appearances of volatile findings still count as real —
      // a finding flipping from "present on 7 pages" to "gone entirely" is
      // structurally significant. Only `count` deltas can be noise.
      if (kind === 'count' && isNoise(entry, volatile)) {
        noise.push(diff);
      } else {
        real.push(diff);
      }
    }

    // Sort each bucket by severity then absolute delta
    const sevRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const sort = (arr: AuditDiffEntry[]) =>
      arr.sort((a, b) => {
        const sa = sevRank[(a.severity ?? '').toString().toLowerCase()] ?? 9;
        const sb = sevRank[(b.severity ?? '').toString().toLowerCase()] ?? 9;
        if (sa !== sb) return sa - sb;
        return Math.abs(b.newCount - b.oldCount) - Math.abs(a.newCount - a.oldCount);
      });
    sort(real);
    sort(noise);

    // "Site changed": compare per-page hashes
    const oldHashes = oldAudit.pageHashes ?? {};
    const newHashes = newAudit.pageHashes ?? {};
    const sharedUrls = Object.keys(oldHashes).filter((u) => newHashes[u] !== undefined);
    const pagesChanged = sharedUrls.filter((u) => oldHashes[u] !== newHashes[u]).length;
    const pagesUnchanged = sharedUrls.length - pagesChanged;
    const pagesUnique =
      Object.keys(oldHashes).filter((u) => newHashes[u] === undefined).length +
      Object.keys(newHashes).filter((u) => oldHashes[u] === undefined).length;

    return {
      real,
      noise,
      siteChanged: {
        pagesCompared: sharedUrls.length,
        pagesChanged,
        pagesUnchanged,
        pagesUnique,
      },
    };
  }

  /**
   * Collect per-page contentHash into a url → hash map.
   * Skips pages without a hash (older audits, or content-fetch failures).
   * @private
   */
  #extractPageHashes(auditData: Partial<AuditResults>): Record<string, string> | undefined {
    const pages = auditData.pageData?.pages ?? {};
    const out: Record<string, string> = {};
    let n = 0;
    for (const [url, page] of Object.entries(pages) as Array<[string, PageInfo]>) {
      const hash = (page as PageInfo).contentHash;
      if (typeof hash === 'string' && hash.length > 0) {
        out[url] = hash;
        n++;
      }
    }
    return n > 0 ? out : undefined;
  }

  generateTrendData() {
    const history = this.loadHistory();

    if (history.audits.length === 0) {
      return null;
    }

    // Generate per-issue trends
    const issueTrends = this.generateIssueTrends(history.audits);

    return {
      labels: history.audits.map((a) => a.date),
      overallScores: history.audits.map((a) => a.summary.overallScore),
      totalIssues: history.audits.map((a) => a.summary.totalIssues),
      criticalIssues: history.audits.map((a) => a.summary.criticalCount),
      highIssues: history.audits.map((a) => a.summary.highCount),
      categoryScores: {
        seo: history.audits.map((a) => a.summary.categoryScores?.seo ?? 0),
        performance: history.audits.map((a) => a.summary.categoryScores?.performance ?? 0),
        accessibility: history.audits.map((a) => a.summary.categoryScores?.accessibility ?? 0),
        security: history.audits.map((a) => a.summary.categoryScores?.security ?? 0),
        technical: history.audits.map((a) => a.summary.categoryScores?.technical ?? 0),
      },
      performance: {
        // Keep nulls to maintain alignment with labels array (Chart.js handles null as gaps)
        ttfb: history.audits.map((a) => a.performance?.avgTTFB ?? null),
        lcp: history.audits.map((a) => a.performance?.avgLCP ?? null),
        cls: history.audits.map((a) => a.performance?.avgCLS ?? null),
      },
      issueTrends,
      insights: {
        languageMismatches: history.audits.map((a) => a.insights?.languageMismatches ?? null),
        brokenOutboundLinks: history.audits.map((a) => a.insights?.brokenOutboundLinks ?? null),
        nearDuplicatePages: history.audits.map((a) => a.insights?.nearDuplicatePages ?? null),
        avgJsUnused: history.audits.map((a) => a.insights?.avgJsUnused ?? null),
      },
    };
  }

  /**
   * Generate per-issue trend data across all audits
   * @param {Array} audits - Array of audit snapshots
   * @returns {Object} Issue trends with labels, counts, severity, and trend direction
   */
  generateIssueTrends(audits: AuditSnapshot[]): Record<string, IssueTrend> | null {
    if (audits.length < 2) {
      return null;
    }

    // Collect all unique issues across all audits
    const allIssues = new Set<string>();
    audits.forEach((audit) => {
      Object.keys(audit.issues ?? {}).forEach((issue) => allIssues.add(issue));
    });

    const trends: Record<string, IssueTrend> = {};
    const labels = audits.map((a) => a.date);

    allIssues.forEach((issue) => {
      const counts = audits.map((audit) => audit.issues?.[issue]?.count ?? 0);
      const latestAudit = audits[audits.length - 1];
      const severity =
        latestAudit.issues?.[issue]?.severity ||
        audits.find((a) => a.issues?.[issue])?.issues?.[issue]?.severity ||
        'medium';

      // Calculate trend direction
      const firstNonZero = counts.findIndex((c) => c > 0);
      const reverseIndex = [...counts].reverse().findIndex((c) => c > 0);
      // Handle case when all counts are 0 (reverseIndex would be -1)
      const lastNonZero = reverseIndex === -1 ? -1 : counts.length - 1 - reverseIndex;
      const latestCount = counts[counts.length - 1] ?? 0;

      let trend: IssueTrend['trend'];
      if (firstNonZero === -1) {
        // All counts are zero - issue never existed
        trend = 'stable';
      } else if (firstNonZero === counts.length - 1) {
        // Only appeared in the latest audit
        trend = 'new';
      } else if (latestCount === 0 && lastNonZero < counts.length - 1) {
        // Was present before but not in latest - issue is fixed
        trend = 'fixed';
      } else {
        // Compare first occurrence value to latest value
        const firstVal = counts[firstNonZero];
        const lastVal = latestCount;

        if (lastVal < firstVal * 0.8) {
          trend = 'improving';
        } else if (lastVal > firstVal * 1.2) {
          trend = 'worsening';
        } else {
          trend = 'stable';
        }
      }

      // Calculate change from first occurrence to latest
      const firstCount = counts[firstNonZero] ?? 0;
      // latestCount already defined above
      const change = latestCount - firstCount;
      const changePercent = firstCount > 0 ? (((latestCount - firstCount) / firstCount) * 100).toFixed(0) : 0;

      trends[issue] = {
        labels,
        counts,
        severity,
        trend,
        latestCount,
        change,
        changePercent,
      };
    });

    return trends;
  }
}

export { HistoryManager };
// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'save' && args[1]) {
    const jsonFile = args[1];
    // Extract domain name from filename and sanitize consistently
    const rawDomain = path
      .basename(jsonFile)
      .replace('SEOAnalysis__', '')
      .replace(/\.json(\.gz)?$/, '');
    const domainName = sanitizeDomainName(rawDomain);
    const auditData = FileManager.readJsonFile(jsonFile);

    const manager = new HistoryManager(domainName);
    manager.addAuditSnapshot(auditData);
  } else if (command === 'list' && args[1]) {
    const domainName = args[1];
    const manager = new HistoryManager(domainName);
    const audits = manager.getAllAudits();

    console.log(`\n📊 Audit History for ${domainName}\n`);
    audits.forEach((audit, i: number) => {
      console.log(
        `${i + 1}. ${audit.date} - Score: ${audit.summary.overallScore}, Issues: ${audit.summary.totalIssues}`,
      );
    });
    console.log(`\nTotal audits: ${audits.length}`);
  } else if (command === 'compare' && args[1] && args[2] && args[3]) {
    const domainName = args[1];
    const oldIndex = parseInt(args[2], 10) - 1;
    const newIndex = parseInt(args[3], 10) - 1;

    const manager = new HistoryManager(domainName);
    const oldAudit = manager.getAuditByIndex(oldIndex);
    const newAudit = manager.getAuditByIndex(newIndex);

    if (!oldAudit || !newAudit) {
      console.error('Error: Invalid audit indices');
      process.exit(1);
    }

    const comparison = manager.compareAudits(oldAudit, newAudit);
    console.log(`\n📊 Comparison: ${comparison.oldDate} → ${comparison.newDate}\n`);
    console.log(
      `Overall Score: ${oldAudit.summary.overallScore} → ${newAudit.summary.overallScore} (${comparison.scoreChange > 0 ? '+' : ''}${comparison.scoreChange})`,
    );
    console.log(
      `Total Issues: ${oldAudit.summary.totalIssues} → ${newAudit.summary.totalIssues} (${comparison.deltaMetrics.totalIssues > 0 ? '+' : ''}${comparison.deltaMetrics.totalIssues})`,
    );

    if (comparison.improvements.length > 0) {
      console.log(`\n✅ Improvements (${comparison.improvements.length}):`);
      comparison.improvements.forEach((imp) => console.log(`   - ${imp}`));
    }

    if (comparison.regressions.length > 0) {
      console.log(`\n⚠️  Regressions (${comparison.regressions.length}):`);
      comparison.regressions.forEach((reg) => console.log(`   - ${reg}`));
    }
  } else {
    console.log(`
Usage:
  node historyManager.js save <json-file>           Save audit to history
  node historyManager.js list <domain>              List all audits
  node historyManager.js compare <domain> <old> <new>  Compare two audits
    `);
  }
}
