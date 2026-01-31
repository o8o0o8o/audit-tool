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

  /**
   * Create a ProgressReporter
   * @param {number} total - Total items to process
   * @param {number} logInterval - Minimum ms between progress logs (default: 2000)
   * @param {number} alreadyProcessed - Items already processed from previous run (for resume)
   */
  constructor(total, logInterval = 2000, alreadyProcessed = 0) {
    this.#total = total;
    this.#processed = 0;
    this.#succeeded = 0;
    this.#failed = 0;
    this.#skipped = alreadyProcessed; // Initialize with already processed count for resume
    this.#startTime = Date.now();
    this.#lastLogTime = 0;
    this.#logInterval = logInterval;
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
   * Force log current progress
   */
  forceLog() {
    this.#log();
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
    const stats = this.getStats();
    console.log('\n' + '═'.repeat(50));
    console.log('CRAWL COMPLETE');
    console.log('═'.repeat(50));
    console.log(`Total URLs:      ${stats.total}`);
    console.log(`Processed:       ${stats.processed}`);
    console.log(`  ✓ Succeeded:   ${stats.succeeded}`);
    console.log(`  ✗ Failed:      ${stats.failed}`);
    console.log(`  ⊘ Skipped:     ${stats.skipped}`);
    console.log(`Duration:        ${stats.elapsedFormatted}`);
    console.log(`Avg Rate:        ${stats.rate} pages/sec`);
    console.log('═'.repeat(50) + '\n');
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

    if (status === 'success') {
      statusIcon = '✓';
      statusText = duration ? `(${(duration / 1000).toFixed(1)}s)` : '';
    } else if (status === 'fail') {
      statusIcon = '✗';
      statusText = reason ? `(${reason})` : '';
    }

    const shortUrl = url ? this.#truncateUrl(url, 40) : '';

    console.log(
      `${progressBar} ${stats.percentComplete}% | ` +
      `${stats.processed}/${stats.total} | ` +
      `${stats.elapsedFormatted} elapsed | ` +
      `ETA: ${stats.etaFormatted} | ` +
      `${statusIcon} ${shortUrl} ${statusText}`
    );
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
    const RED = '\x1b[31m';
    const YELLOW = '\x1b[33m';
    const GREEN = '\x1b[32m';

    // Choose color based on progress
    let color;
    if (percent < 34) {
      color = RED;
    } else if (percent < 67) {
      color = YELLOW;
    } else {
      color = GREEN;
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
