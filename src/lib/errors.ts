/**
 * Error model for outbound integrations.
 *
 * The only distinction the retry/backoff layer cares about is whether a failure
 * is worth retrying. We encode that in `kind` so callers branch on one field
 * instead of re-inspecting status codes everywhere:
 *
 *   - `transient`  -> 429, 5xx, timeouts, connection resets. Safe to retry with backoff.
 *   - `permanent`  -> 4xx (except 429). Retrying will just fail again; surface it.
 */
export type JiraErrorKind = 'transient' | 'permanent';

export interface JiraErrorOptions {
  /** HTTP status, when the failure came from a response (absent for network errors). */
  readonly status?: number;
  /** Underlying error (socket error, parse failure, etc.). */
  readonly cause?: unknown;
}

export abstract class JiraError extends Error {
  abstract readonly kind: JiraErrorKind;
  readonly status?: number;

  protected constructor(message: string, options: JiraErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
  }

  get isRetryable(): boolean {
    return this.kind === 'transient';
  }
}

/** Retryable failure: 429, 5xx, or a network/timeout error. */
export class TransientJiraError extends JiraError {
  readonly kind = 'transient';
  /** Parsed from the `Retry-After` header on 429s, when present (milliseconds). */
  readonly retryAfterMs?: number;

  constructor(message: string, options: JiraErrorOptions & { retryAfterMs?: number } = {}) {
    super(message, options);
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Non-retryable failure: a 4xx other than 429 (auth, validation, not found, ...). */
export class PermanentJiraError extends JiraError {
  readonly kind = 'permanent';

  constructor(message: string, options: JiraErrorOptions = {}) {
    super(message, options);
  }
}

/**
 * Parse a `Retry-After` header into milliseconds. JIRA Cloud sends either a
 * delta-seconds integer or an HTTP-date; we support delta-seconds (the common
 * case) and return undefined for anything we can't parse so the backoff layer
 * falls back to its own schedule.
 */
function parseRetryAfterMs(headers?: Headers): number | undefined {
  const raw = headers?.get('retry-after');
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  return undefined;
}

/** Compact a response body into a short string for error messages. */
function summarizeBody(body: unknown): string {
  if (body === null || body === undefined || body === '') {
    return '';
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Classify a completed HTTP response into the right error type.
 * 429 and >=500 are transient (retryable); every other >=400 is permanent.
 */
export function classifyResponseError(status: number, body: unknown, headers?: Headers): JiraError {
  const summary = summarizeBody(body);
  const suffix = summary ? `: ${summary}` : '';

  if (status === 429 || status >= 500) {
    return new TransientJiraError(`JIRA request failed with ${status}${suffix}`, {
      status,
      retryAfterMs: parseRetryAfterMs(headers),
    });
  }
  return new PermanentJiraError(`JIRA request failed with ${status}${suffix}`, { status });
}

/** Wrap a thrown network/timeout error (no HTTP response) as transient. */
export function asTransientNetworkError(cause: unknown): TransientJiraError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new TransientJiraError(`JIRA request failed (network/timeout): ${detail}`, { cause });
}
