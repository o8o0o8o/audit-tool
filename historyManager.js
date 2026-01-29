const fs = require('fs');
const path = require('path');

/**
 * Audit History Manager
 * Tracks audit results over time for trend analysis and comparison
 */

class HistoryManager {
  constructor(domainName, baseResultsDir = 'audit-results') {
    this.domainName = domainName;
    this.baseResultsDir = baseResultsDir;

    // New structure: audit-results/domain.com/audit-history.json
    this.domainDir = path.join(this.baseResultsDir, this.domainName);
    this.historyFile = path.join(this.domainDir, 'audit-history.json');

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

  loadHistory() {
    // Try new location first
    if (fs.existsSync(this.historyFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      } catch (error) {
        console.error(`Error loading history: ${error.message}`);
        return { domain: this.domainName, audits: [] };
      }
    }

    // Check legacy location for migration
    if (fs.existsSync(this.legacyHistoryFile)) {
      console.log(`📦 Migrating history from legacy location...`);
      try {
        const legacyHistory = JSON.parse(fs.readFileSync(this.legacyHistoryFile, 'utf8'));
        // Save to new location
        this.saveHistory(legacyHistory);
        console.log(`✓ History migrated to: ${this.historyFile}`);
        return legacyHistory;
      } catch (error) {
        console.error(`Error migrating history: ${error.message}`);
      }
    }

    return { domain: this.domainName, audits: [] };
  }

  saveHistory(history) {
    fs.writeFileSync(this.historyFile, JSON.stringify(history, null, 2));
  }

  addAuditSnapshot(auditData, runTimestamp = null) {
    const history = this.loadHistory();

    const snapshot = {
      timestamp: new Date().toISOString(),
      date: new Date().toLocaleDateString(),
      runTimestamp: runTimestamp || null, // Link to run directory
      summary: {
        overallScore: auditData.analysis?.summary?.overallScore || 0,
        totalIssues: auditData.analysis?.summary?.totalIssues || 0,
        criticalCount: auditData.analysis?.summary?.criticalCount || 0,
        highCount: auditData.analysis?.summary?.highCount || 0,
        mediumCount: auditData.analysis?.summary?.mediumCount || 0,
        lowCount: auditData.analysis?.summary?.lowCount || 0,
        passRate: auditData.analysis?.summary?.passRate || 0,
        categoryScores: auditData.analysis?.summary?.categoryScores || {},
        totalPages: Object.keys(auditData.pageData?.pages || {}).length,
        pagesWithErrors: auditData.pageData?.totalWithError || 0,
        sitemapUrls: auditData.sitemaps?.total || 0
      },
      issues: this.extractIssuesSummary(auditData),
      performance: this.extractPerformanceSummary(auditData),
      quickWins: (auditData.analysis?.summary?.quickWins || []).map(qw => ({
        issue: qw.issue,
        affectedPages: qw.affectedPages,
        severity: qw.severity
      }))
    };

    history.audits.push(snapshot);
    this.saveHistory(history);

    console.log(`\n📊 Audit snapshot saved to history`);
    console.log(`   Total audits: ${history.audits.length}`);

    return snapshot;
  }

  extractIssuesSummary(auditData) {
    const details = auditData.analysis?.details || {};
    const summary = {};

    Object.entries(details).forEach(([issue, data]) => {
      summary[issue] = {
        severity: data.severity,
        count: data.examples?.length || 0
      };
    });

    return summary;
  }

  extractPerformanceSummary(auditData) {
    const pages = auditData.pageData?.pages || {};
    const pagesWithPerf = Object.values(pages).filter(p => p.vitals);

    if (pagesWithPerf.length === 0) return null;

    const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const ttfbValues = pagesWithPerf.map(p => p.vitals.ttfb || 0).filter(v => v > 0);
    const lcpValues = pagesWithPerf.map(p => p.vitals.lcp || 0).filter(v => v > 0);
    const clsValues = pagesWithPerf.map(p => p.vitals.cls || 0).filter(v => v > 0);

    return {
      avgTTFB: avg(ttfbValues).toFixed(0),
      avgLCP: avg(lcpValues).toFixed(0),
      avgCLS: avg(clsValues).toFixed(3),
      pagesWithMetrics: pagesWithPerf.length
    };
  }

  getLatestAudit() {
    const history = this.loadHistory();
    return history.audits.length > 0 ? history.audits[history.audits.length - 1] : null;
  }

  getAuditByIndex(index) {
    const history = this.loadHistory();
    return history.audits[index] || null;
  }

  getAllAudits() {
    const history = this.loadHistory();
    return history.audits;
  }

  compareAudits(oldAudit, newAudit) {
    const comparison = {
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
        passRate: newAudit.summary.passRate - oldAudit.summary.passRate
      }
    };

    // Compare category scores
    if (oldAudit.summary.categoryScores && newAudit.summary.categoryScores) {
      comparison.categoryDeltas = {};
      ['seo', 'performance', 'accessibility', 'security', 'technical'].forEach(cat => {
        const oldScore = oldAudit.summary.categoryScores[cat] || 0;
        const newScore = newAudit.summary.categoryScores[cat] || 0;
        comparison.categoryDeltas[cat] = newScore - oldScore;
      });
    }

    // Compare performance metrics
    if (oldAudit.performance && newAudit.performance) {
      comparison.performanceDeltas = {
        ttfb: parseFloat(newAudit.performance.avgTTFB) - parseFloat(oldAudit.performance.avgTTFB),
        lcp: parseFloat(newAudit.performance.avgLCP) - parseFloat(oldAudit.performance.avgLCP),
        cls: parseFloat(newAudit.performance.avgCLS) - parseFloat(oldAudit.performance.avgCLS)
      };
    }

    // Detect fixed issues and new issues
    const oldIssues = new Set(Object.keys(oldAudit.issues));
    const newIssues = new Set(Object.keys(newAudit.issues));

    oldIssues.forEach(issue => {
      if (!newIssues.has(issue)) {
        comparison.fixed.push(issue);
        comparison.improvements.push(`Fixed: ${issue}`);
      } else if (oldAudit.issues[issue].count > newAudit.issues[issue].count) {
        const reduction = oldAudit.issues[issue].count - newAudit.issues[issue].count;
        comparison.improvements.push(`${issue}: Reduced from ${oldAudit.issues[issue].count} to ${newAudit.issues[issue].count} pages (-${reduction})`);
      } else if (oldAudit.issues[issue].count < newAudit.issues[issue].count) {
        const increase = newAudit.issues[issue].count - oldAudit.issues[issue].count;
        comparison.regressions.push(`${issue}: Increased from ${oldAudit.issues[issue].count} to ${newAudit.issues[issue].count} pages (+${increase})`);
      }
    });

    newIssues.forEach(issue => {
      if (!oldIssues.has(issue)) {
        comparison.newIssues.push(issue);
        comparison.regressions.push(`New issue: ${issue} (${newAudit.issues[issue].count} pages)`);
      }
    });

    return comparison;
  }

  generateTrendData() {
    const history = this.loadHistory();

    if (history.audits.length === 0) {
      return null;
    }

    return {
      labels: history.audits.map(a => a.date),
      overallScores: history.audits.map(a => a.summary.overallScore),
      totalIssues: history.audits.map(a => a.summary.totalIssues),
      criticalIssues: history.audits.map(a => a.summary.criticalCount),
      highIssues: history.audits.map(a => a.summary.highCount),
      categoryScores: {
        seo: history.audits.map(a => a.summary.categoryScores?.seo || 0),
        performance: history.audits.map(a => a.summary.categoryScores?.performance || 0),
        accessibility: history.audits.map(a => a.summary.categoryScores?.accessibility || 0),
        security: history.audits.map(a => a.summary.categoryScores?.security || 0),
        technical: history.audits.map(a => a.summary.categoryScores?.technical || 0)
      },
      performance: {
        ttfb: history.audits.map(a => a.performance?.avgTTFB || null).filter(v => v !== null),
        lcp: history.audits.map(a => a.performance?.avgLCP || null).filter(v => v !== null),
        cls: history.audits.map(a => a.performance?.avgCLS || null).filter(v => v !== null)
      }
    };
  }
}

module.exports = { HistoryManager };

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'save' && args[1]) {
    const jsonFile = args[1];
    const domainName = jsonFile.replace('SEOAnalysis__', '').replace('.json', '');
    const auditData = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));

    const manager = new HistoryManager(domainName);
    manager.addAuditSnapshot(auditData);
  }
  else if (command === 'list' && args[1]) {
    const domainName = args[1];
    const manager = new HistoryManager(domainName);
    const audits = manager.getAllAudits();

    console.log(`\n📊 Audit History for ${domainName}\n`);
    audits.forEach((audit, i) => {
      console.log(`${i + 1}. ${audit.date} - Score: ${audit.summary.overallScore}, Issues: ${audit.summary.totalIssues}`);
    });
    console.log(`\nTotal audits: ${audits.length}`);
  }
  else if (command === 'compare' && args[1] && args[2] && args[3]) {
    const domainName = args[1];
    const oldIndex = parseInt(args[2]) - 1;
    const newIndex = parseInt(args[3]) - 1;

    const manager = new HistoryManager(domainName);
    const oldAudit = manager.getAuditByIndex(oldIndex);
    const newAudit = manager.getAuditByIndex(newIndex);

    if (!oldAudit || !newAudit) {
      console.error('Error: Invalid audit indices');
      process.exit(1);
    }

    const comparison = manager.compareAudits(oldAudit, newAudit);
    console.log(`\n📊 Comparison: ${comparison.oldDate} → ${comparison.newDate}\n`);
    console.log(`Overall Score: ${oldAudit.summary.overallScore} → ${newAudit.summary.overallScore} (${comparison.scoreChange > 0 ? '+' : ''}${comparison.scoreChange})`);
    console.log(`Total Issues: ${oldAudit.summary.totalIssues} → ${newAudit.summary.totalIssues} (${comparison.deltaMetrics.totalIssues > 0 ? '+' : ''}${comparison.deltaMetrics.totalIssues})`);

    if (comparison.improvements.length > 0) {
      console.log(`\n✅ Improvements (${comparison.improvements.length}):`);
      comparison.improvements.forEach(imp => console.log(`   - ${imp}`));
    }

    if (comparison.regressions.length > 0) {
      console.log(`\n⚠️  Regressions (${comparison.regressions.length}):`);
      comparison.regressions.forEach(reg => console.log(`   - ${reg}`));
    }
  }
  else {
    console.log(`
Usage:
  node historyManager.js save <json-file>           Save audit to history
  node historyManager.js list <domain>              List all audits
  node historyManager.js compare <domain> <old> <new>  Compare two audits
    `);
  }
}
