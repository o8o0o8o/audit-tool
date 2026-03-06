/**
 * Progress Reporter
 * Provides real-time progress feedback during crawling
 */

class ProgressReporter {
  #total;
  #processed;
  #succeeded;
  #failed;
  #skipped;
  #startTime;
  #lastLogTime;
  #logInterval;
  #colorScheme;
  #verbose;
  #isTTY;

  /**
   * Create a ProgressReporter
   * @param {number} total - Total items to process
   * @param {number} logInterval - Minimum ms between progress logs (default: 2000)
   * @param {number} alreadyProcessed - Items already processed from previous run (for resume)
   * @param {string} colorScheme - Color scheme: 'default' (red→yellow→green) or 'discovered' (cyan→blue→magenta)
   * @param {boolean} verbose - Whether to show per-URL logging (default: false)
   */
  constructor(total, logInterval = 2000, alreadyProcessed = 0, colorScheme = 'default', verbose = false) {
    this.#total = total;
    this.#processed = 0;
    this.#succeeded = 0;
    this.#failed = 0;
    this.#skipped = alreadyProcessed; // Initialize with already processed count for resume
    this.#startTime = Date.now();
    this.#lastLogTime = 0;
    this.#logInterval = logInterval;
    this.#colorScheme = colorScheme;
    this.#verbose = verbose;
    this.#isTTY = process.stdout.isTTY || false;
  }

  /**
   * Record a successful item
   * @param {string} url - URL that was processed
   * @param {number} duration - Processing time in ms
   */
  success(url, duration) {
    this.#processed++;
    this.#succeeded++;
    this.#maybeLog(url, 'success', duration);
  }

  /**
   * Record a failed item
   * @param {string} url - URL that failed
   * @param {string} reason - Reason for failure
   */
  fail(url, reason) {
    this.#processed++;
    this.#failed++;
    this.#maybeLog(url, 'fail', null, reason);
  }

  /**
   * Record a skipped item (already processed)
   * @param {string} url - URL that was skipped
   */
  skip(url) {
    this.#skipped++;
  }

  /**
   * Update total count (when new pages are discovered)
   * @param {number} newTotal - New total count
   */
  updateTotal(newTotal) {
    this.#total = newTotal;
  }

  /**
   * Force log current progress (always prints a new line)
   */
  forceLog() {
    // When force logging, print on a new line even in TTY mode
    if (this.#isTTY && !this.#verbose) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    }
    this.#log();
    if (this.#isTTY && !this.#verbose) {
      process.stdout.write('\n');
    }
  }

  /**
   * Get current stats
   * @returns {Object} Current progress statistics
   */
  getStats() {
    const elapsed = Date.now() - this.#startTime;
    const rate = this.#processed / (elapsed / 1000) || 0;
    const remaining = this.#total - this.#processed - this.#skipped;
    const eta = rate > 0 ? remaining / rate : 0;

    return {
      total: this.#total,
      processed: this.#processed,
      succeeded: this.#succeeded,
      failed: this.#failed,
      skipped: this.#skipped,
      remaining,
      elapsed,
      elapsedFormatted: this.#formatTime(elapsed),
      rate: rate.toFixed(1),
      eta,
      etaFormatted: this.#formatTime(eta * 1000),
      percentComplete: ((this.#processed + this.#skipped) / this.#total * 100).toFixed(1),
    };
  }

  /**
   * Print final summary
   */
  printSummary() {
    // Clear in-place progress line before printing summary
    if (this.#isTTY && !this.#verbose) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    }
    const stats = this.getStats();
    const successRate = stats.total > 0 ? ((stats.succeeded / Math.max(1, stats.processed)) * 100).toFixed(1) : '0.0';

    // Memory usage
    let memInfo = '';
    try {
      const mem = process.memoryUsage();
      const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
      const rssMB = Math.round(mem.rss / 1024 / 1024);
      memInfo = `Memory:          ${heapUsedMB}MB / ${heapTotalMB}MB heap (${rssMB}MB RSS)`;
    } catch (_) { /* ignore */ }

    // Speed rating
    const rate = parseFloat(stats.rate);
    let speedRating = '';
    if (rate >= 5) speedRating = ' ⚡ Fast';
    else if (rate >= 2) speedRating = ' ✓ Good';
    else if (rate >= 0.5) speedRating = ' ⚠ Moderate';
    else speedRating = ' 🐢 Slow';

    console.log('\n' + '═'.repeat(50));
    console.log('CRAWL COMPLETE');
    console.log('═'.repeat(50));
    console.log(`Total URLs:      ${stats.total}`);
    console.log(`Processed:       ${stats.processed}`);
    console.log(`  ✓ Succeeded:   ${stats.succeeded} (${successRate}%)`);
    console.log(`  ✗ Failed:      ${stats.failed}`);
    console.log(`  ⊘ Skipped:     ${stats.skipped}`);
    console.log(`Duration:        ${stats.elapsedFormatted}`);
    console.log(`Avg Rate:        ${stats.rate} pages/sec${speedRating}`);
    if (memInfo) console.log(memInfo);
    console.log('═'.repeat(50) + '\n');

    // Reset terminal title and ring bell
    if (this.#isTTY) {
      process.stdout.write('\x1b]0;\x07'); // Reset title
      process.stdout.write('\x07'); // Terminal bell
    }
  }

  /**
   * Log progress if enough time has passed
   * @private
   */
  #maybeLog(url, status, duration, reason) {
    const now = Date.now();
    if (now - this.#lastLogTime >= this.#logInterval) {
      this.#log(url, status, duration, reason);
      this.#lastLogTime = now;
    }
  }

  /**
   * Log current progress
   * @private
   */
  #log(url, status, duration, reason) {
    const stats = this.getStats();
    const progressBar = this.#createProgressBar(stats.percentComplete);

    let statusIcon = '';
    let statusText = '';

    const GREEN = '\x1b[32m';
    const RED = '\x1b[31m';
    const RESET = '\x1b[0m';
    if (status === 'success') {
      statusIcon = `${GREEN}✓${RESET}`;
      statusText = duration ? `(${(duration / 1000).toFixed(1)}s)` : '';
    } else if (status === 'fail') {
      statusIcon = `${RED}✗${RESET}`;
      statusText = reason ? `${RED}(${reason})${RESET}` : '';
    }

    const shortUrl = url ? this.#truncateUrl(url, 40) : '';

    // Show total progress (processed + skipped from resume)
    const totalDone = stats.processed + stats.skipped;
    const progressText = stats.skipped > 0
      ? `${totalDone}/${stats.total} (+${stats.processed} new)`
      : `${stats.processed}/${stats.total}`;

    const line =
      `${progressBar} ${stats.percentComplete}% | ` +
      `${progressText} | ` +
      `${stats.elapsedFormatted} elapsed | ` +
      `ETA: ${stats.etaFormatted}`;

    // Update terminal title bar with progress
    if (this.#isTTY) {
      process.stdout.write(`\x1b]0;SEO Audit ${stats.percentComplete}% | ETA: ${stats.etaFormatted}\x07`);
    }

    if (this.#isTTY && !this.#verbose) {
      // In-place update: overwrite the current line
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      process.stdout.write(line);
    } else {
      // Non-TTY or verbose mode: print full line with URL details
      console.log(
        `${line} | ${statusIcon} ${shortUrl} ${statusText}`
      );
    }
  }

  /**
   * Create a visual progress bar with color based on progress
   * @private
   */
  #createProgressBar(percent) {
    const width = 20;
    // Clamp filled to [0, width] to handle edge cases (>100% or negative)
    const filled = Math.min(width, Math.max(0, Math.round(width * percent / 100)));
    const empty = width - filled;

    // ANSI color codes
    const RESET = '\x1b[0m';

    // Color schemes
    const schemes = {
      // Default: red → yellow → green (sitemap crawl)
      default: {
        low: '\x1b[31m',    // Red
        mid: '\x1b[33m',    // Yellow
        high: '\x1b[32m',   // Green
      },
      // Discovered links: bright red → bright yellow → bright green
      discovered: {
        low: '\x1b[91m',    // Bright Red
        mid: '\x1b[93m',    // Bright Yellow
        high: '\x1b[92m',   // Bright Green
      },
    };

    const colors = schemes[this.#colorScheme] || schemes.default;

    // Choose color based on progress
    let color;
    if (percent < 34) {
      color = colors.low;
    } else if (percent < 67) {
      color = colors.mid;
    } else {
      color = colors.high;
    }

    return '[' + color + '█'.repeat(filled) + RESET + '░'.repeat(empty) + ']';
  }

  /**
   * Format milliseconds to human readable time
   * @private
   */
  #formatTime(ms) {
    if (!ms || ms < 0) return '0:00';

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    }
    return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
  }

  /**
   * Truncate URL for display
   * @private
   */
  #truncateUrl(url, maxLength) {
    if (url.length <= maxLength) return url;

    try {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path.length > maxLength - 3) {
        return '...' + path.slice(-(maxLength - 3));
      }
      return path;
    } catch {
      return '...' + url.slice(-(maxLength - 3));
    }
  }
}

module.exports = { ProgressReporter };
