/**
 * Phase Progress
 *
 * Lightweight progress feedback for the post-crawl phases (repo analysis,
 * Phase 2 curated report, Phase 3 verification). The crawl itself uses the
 * richer {@link ProgressReporter}; these phases only need a compact
 * "label  i/N  pct%  | elapsed | ETA" line for their long-running loops.
 *
 * Two shapes:
 *  - {@link PhaseProgress} — a loop; call `tick()` per completed item. Renders
 *    an in-place line on a TTY (throttled), or periodic full lines on a
 *    non-TTY. With a known `total`, shows `i/N pct% | elapsed | ETA` (ETA
 *    extrapolated from the observed rate — meaningful for sequential loops, a
 *    reasonable estimate for parallel ones that complete in bursts). With an
 *    unknown total (pass `0`), shows a count-only `N | elapsed` line — no
 *    pct/ETA, since extrapolating toward an unknown end would mislead.
 *  - {@link timedStep} — a single long op with no item count (e.g. a PDF
 *    render); prints a start line and a `✓ … (elapsed)` line when it resolves.
 */

/** Format milliseconds as `m:ss` (or `h:mm:ss`). */
function formatTime(ms: number): string {
  if (!ms || ms < 0 || !Number.isFinite(ms)) return '0:00';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  }
  return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
}

interface PhaseProgressOptions {
  /** Minimum ms between rendered updates (default: 500). */
  intervalMs?: number;
}

class PhaseProgress {
  #label: string;
  #total: number;
  #done = 0;
  #start: number;
  #lastLog = 0;
  #interval: number;
  #isTTY: boolean;
  #drawn = false;

  /**
   * @param label - Short step name shown at the head of the line.
   * @param total - Number of items the loop will process; pass `0` for an
   *   unknown/growing total (count-only display, no pct/ETA).
   */
  constructor(label: string, total: number, options: PhaseProgressOptions = {}) {
    this.#label = label;
    this.#total = Math.max(0, total);
    this.#start = Date.now();
    this.#interval = options.intervalMs ?? 500;
    this.#isTTY = process.stdout.isTTY || false;
  }

  /** Record `n` completed items (default 1) and maybe redraw. */
  tick(n = 1): void {
    this.#done += n;
    this.#render(false);
  }

  /**
   * Finalize the line: clears the in-place line on a TTY and prints a single
   * completed summary. `summary` overrides the default "label: done/total".
   */
  done(summary?: string): void {
    if (this.#isTTY && this.#drawn) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    }
    const elapsed = Date.now() - this.#start;
    const count = this.#total > 0 ? `${this.#done}/${this.#total}` : `${this.#done}`;
    const msg = summary ?? `${this.#label}: ${count}`;
    console.log(`  ✓ ${msg} (${formatTime(elapsed)})`);
  }

  #render(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.#lastLog < this.#interval) return;
    this.#lastLog = now;

    const elapsed = now - this.#start;
    let line: string;
    if (this.#total > 0) {
      const rate = this.#done / (elapsed / 1000) || 0;
      const remaining = Math.max(0, this.#total - this.#done);
      const eta = rate > 0 ? remaining / rate : 0;
      const pct = Math.min(100, (this.#done / this.#total) * 100);
      line =
        `  - ${this.#label}: ${this.#done}/${this.#total} (${pct.toFixed(0)}%) | ` +
        `${formatTime(elapsed)} elapsed | ETA ${formatTime(eta * 1000)}`;
    } else {
      // Unknown total — honest count-only line, no pct/ETA.
      line = `  - ${this.#label}: ${this.#done} | ${formatTime(elapsed)} elapsed`;
    }

    if (this.#isTTY) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      process.stdout.write(line);
      this.#drawn = true;
    } else {
      console.log(line);
    }
  }
}

/**
 * Run a single long-running async op with a start line and a timed completion
 * line. Use for steps that have no per-item count (PDF render, a single
 * batched LLM call). Re-throws after printing a failure line so callers keep
 * their own error handling.
 */
async function timedStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  console.log(`  - ${label}…`);
  try {
    const result = await fn();
    console.log(`  ✓ ${label} (${formatTime(Date.now() - start)})`);
    return result;
  } catch (err) {
    console.log(`  ✗ ${label} failed (${formatTime(Date.now() - start)})`);
    throw err;
  }
}

export { PhaseProgress, timedStep };
