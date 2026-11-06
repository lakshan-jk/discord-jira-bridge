/**
 * Retry / dead-letter policy. Pure functions, no I/O — shared by BOTH the pg and
 * in-memory queue implementations, so the behaviour the sync engine relies on is
 * identical in production and in tests, and is unit-testable on its own.
 */

import type { FailureReport } from './types.js';

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000; // 5 minutes

/**
 * Decide what happens to an event after a failed processing attempt.
 *
 *  - Permanent failures (4xx other than 429) never retry — straight to dead-letter.
 *  - Transient failures retry until `attempts` reaches `maxAttempts`, then
 *    dead-letter so a poison event can't block its project's queue forever.
 *
 * `attempts` is the count *including* the attempt that just failed (the queue bumps
 * it at claim time), so `attempts >= maxAttempts` means "no budget left".
 */
export function decideFailure(params: {
  attempts: number;
  maxAttempts: number;
  kind: FailureReport['kind'];
}): 'retry' | 'dead-letter' {
  if (params.kind === 'permanent') {
    return 'dead-letter';
  }
  return params.attempts >= params.maxAttempts ? 'dead-letter' : 'retry';
}

/**
 * Backoff before the next retry. Honours a server-provided Retry-After (JIRA 429)
 * when present; otherwise exponential on attempt count, capped at MAX_BACKOFF_MS.
 */
export function backoffDelayMs(attempts: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, MAX_BACKOFF_MS);
  }
  const exponent = Math.max(0, attempts - 1);
  return Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}
