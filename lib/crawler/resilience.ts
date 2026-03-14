/**
 * Resilience utilities for the Crawler Engine
 * Circuit breaker, backoff, timeout, and error handling
 */

import type { FailureTracker, BackoffState, CrawlResults, ReportIssueFn } from './crawler-types';

// Circuit breaker constants
export const CIRCUIT_THRESHOLD = 10; // Open after 10 consecutive failures
export const CIRCUIT_COOLDOWN = 60000; // 60 second cooldown

/**
 * Get backoff delay for an error type using exponential backoff
 */
export function getBackoffDelay(errorType: string, backoffState: Map<string, BackoffState>): number {
  const state = backoffState.get(errorType) || { attempts: 0, lastAttempt: 0 };
  const now = Date.now();

  // Reset if last attempt was more than 5 minutes ago
  if (now - state.lastAttempt > 300000) {
    state.attempts = 0;
  }

  // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
  const baseDelay = 1000;
  const maxDelay = 30000;
  const delay = Math.min(baseDelay * Math.pow(2, state.attempts), maxDelay);

  // Update state
  state.attempts++;
  state.lastAttempt = now;
  backoffState.set(errorType, state);

  return delay;
}

/**
 * Check if circuit breaker should prevent crawling
 * Opens circuit after 10 consecutive failures, closes after 60s cooldown
 */
export function isCircuitOpen(tracker: FailureTracker): boolean {
  const now = Date.now();

  if (tracker.circuitOpen) {
    // Check if cooldown has passed
    if (now - tracker.circuitOpenTime > CIRCUIT_COOLDOWN) {
      console.log('🔌 Circuit breaker: Cooldown passed, closing circuit (half-open state)');
      tracker.circuitOpen = false;
      tracker.consecutiveFailures = Math.floor(CIRCUIT_THRESHOLD / 2); // Half-open: reduce threshold
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Record a failure for circuit breaker
 */
export function recordFailure(tracker: FailureTracker, _errorType: string): void {
  tracker.consecutiveFailures++;
  tracker.lastFailureTime = Date.now();

  if (tracker.consecutiveFailures >= CIRCUIT_THRESHOLD && !tracker.circuitOpen) {
    console.warn(`⚡ Circuit breaker: Opening after ${CIRCUIT_THRESHOLD} consecutive failures`);
    tracker.circuitOpen = true;
    tracker.circuitOpenTime = Date.now();
  }
}

/**
 * Record a success - resets failure counter
 */
export function recordSuccess(tracker: FailureTracker, backoffState: Map<string, BackoffState>): void {
  tracker.consecutiveFailures = 0;
  // Clear backoff state on success
  backoffState.clear();
}

/**
 * Wrap a promise with a timeout
 * Uses AbortController pattern for cleaner cancellation handling
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string = 'Observer timeout'): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let timedOut = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        reject(new Error(message));
      }
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    settled = true;
    return result;
  } catch (error: unknown) {
    settled = true;
    throw error;
  } finally {
    clearTimeout(timeoutId);
    // Attach catch to original promise to prevent unhandled rejection warning
    // Only ignore errors if we timed out - otherwise log unexpected errors
    // that occur after the race is settled
    promise.catch((err) => {
      if (timedOut) {
        // Expected: timeout won the race, original promise rejected later
        // Log at debug level for troubleshooting
        console.debug?.(`[withTimeout] Post-timeout rejection for "${message}": ${err.message}`);
      } else if (!settled) {
        // Unexpected: promise rejected but race somehow didn't catch it
        console.error(`[withTimeout] Unexpected unhandled rejection: ${err.message}`);
      }
      // If settled is true and not timedOut, the error was already thrown/handled
    });
  }
}

/**
 * Categorize error type for better debugging and reporting
 */
export function categorizeError(error: Error): string {
  const message = (error.message || '').toLowerCase();
  const name = (error.name || '').toLowerCase();

  // Timeout errors
  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    name.includes('timeout') ||
    message.includes('observer timeout')
  ) {
    return 'timeout';
  }

  // DNS/Network resolution errors
  if (message.includes('err_name_not_resolved') || message.includes('getaddrinfo') || message.includes('dns')) {
    return 'dns_error';
  }

  // Connection errors
  if (
    message.includes('err_connection') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('connection refused')
  ) {
    return 'connection_error';
  }

  // SSL/TLS errors
  if (message.includes('ssl') || message.includes('certificate') || message.includes('err_cert')) {
    return 'ssl_error';
  }

  // Too many redirects
  if (message.includes('err_too_many_redirects') || message.includes('redirect')) {
    return 'redirect_error';
  }

  // Navigation errors
  if (message.includes('navigation') || message.includes('net::')) {
    return 'navigation_error';
  }

  // Default to crashed
  return 'crashed';
}

/**
 * Get a user-friendly error explanation
 */
export function getFriendlyErrorMessage(errorType: string): string {
  const messages: Record<string, string> = {
    timeout: 'Page took too long to load (>30s). The server may be slow or blocking automated requests.',
    dns_error: 'Could not resolve domain. Check the URL spelling and DNS configuration.',
    connection_error: 'Connection refused. The server may be down or blocking the request.',
    ssl_error: 'SSL/TLS certificate error. The site may have an expired or invalid certificate.',
    redirect_error: 'Too many redirects. Check for redirect loops in server configuration.',
    navigation_error: 'Navigation failed. The page may have returned an unexpected response.',
    crashed: 'Page caused the browser to crash. It may have excessive JavaScript or memory usage.',
  };
  return messages[errorType] || 'Unknown error occurred.';
}

/**
 * Handle page load error with categorization
 */
export function handlePageError(
  error: Error,
  url: string,
  results: CrawlResults,
  verbose: boolean,
  reportIssue: ReportIssueFn,
  saveAttempt: (url: string) => void,
  checkAttempts: (url: string) => void,
): void {
  const errorType = categorizeError(error);
  const messageOverall = `${error.name} ${error.message} ${(error as Error & { cause?: string }).cause || ''}`.trim();
  const friendlyMessage = getFriendlyErrorMessage(errorType);

  // Log user-friendly message, with raw error in verbose or non-TTY mode
  if (verbose) {
    console.log(`\x1b[31m✗\x1b[0m ${url}\n  [${errorType}] ${friendlyMessage}\n  Raw: ${messageOverall}`);
  } else {
    console.log(`\x1b[31m✗\x1b[0m ${url} - ${friendlyMessage}`);
  }

  results.pageData.totalWithError += 1;

  // Track by specific error type for better reporting
  if (!results.pageData.byError[errorType]) {
    results.pageData.byError[errorType] = [];
    results.pageData.byError[`total_${errorType}`] = 0;
  }

  (results.pageData.byError[errorType] as string[]).push(url);
  results.pageData.byError[`total_${errorType}`] = (results.pageData.byError[`total_${errorType}`] as number) + 1;

  // Also track in legacy "crashed" category for backwards compatibility
  if (errorType !== 'crashed') {
    if (!results.pageData.byError.crashed) {
      results.pageData.byError.crashed = [];
      results.pageData.byError.totalCrashed = 0;
    }
    (results.pageData.byError.crashed as string[]).push(url);
    results.pageData.byError.totalCrashed = (results.pageData.byError.totalCrashed as number) + 1;
  }

  saveAttempt(url);
  checkAttempts(url);
}
