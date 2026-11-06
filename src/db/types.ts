/**
 * Shared types for the persistence layer. These describe the public surface the
 * sync engine depends on — plain domain objects, no SQL rows or pg specifics.
 */

export type EventStatus = 'pending' | 'processing' | 'done' | 'failed';

/** A durably-stored Discord event, as handed back to a worker. */
export interface QueueEvent {
  /** BIGINT identity, surfaced as a string so large ids never lose precision. */
  readonly id: string;
  /** Partition key for ordering: events within one project are processed in order. */
  readonly projectKey: string;
  readonly eventType: string;
  readonly discordThreadId: string;
  readonly payload: unknown;
  readonly status: EventStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly availableAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EnqueueInput {
  readonly projectKey: string;
  readonly eventType: string;
  readonly discordThreadId: string;
  readonly payload: unknown;
  /** Overrides the default retry ceiling for this event. */
  readonly maxAttempts?: number;
}

/**
 * How a processing failure was classified, mirroring lib/errors' transient-vs-
 * permanent split. The queue uses `kind` to decide retry vs dead-letter and
 * `retryAfterMs` (from a JIRA 429 Retry-After) to time the backoff.
 */
export interface FailureReport {
  readonly kind: 'transient' | 'permanent';
  readonly message: string;
  readonly retryAfterMs?: number;
}

/** What `markFailed` decided to do with the event. */
export type FailureOutcome =
  | { readonly action: 'retry'; readonly availableAt: Date; readonly attempts: number }
  | { readonly action: 'dead-letter'; readonly attempts: number };

/**
 * The durable event queue. The sync engine depends on THIS interface, not the pg
 * implementation, so it can be unit-tested against the in-memory fake — same
 * pattern as the JIRA client.
 *
 * At-least-once, not exactly-once: a worker can crash after the JIRA write but
 * before `markDone`, so the same event may be delivered again. Every downstream
 * consumer MUST therefore be idempotent — which is exactly what the dedup lookup
 * (MappingStore.findByThreadId) and the unique constraint (MappingStore.insert
 * throwing DuplicateMappingError) provide.
 */
export interface EventQueue {
  /** Persist an event as pending. This is the "store before act" step. */
  enqueue(input: EnqueueInput): Promise<QueueEvent>;

  /**
   * Atomically claim the next eligible event, honouring per-project ordering: it
   * returns the earliest pending event belonging to a project that has nothing in
   * flight, skipping (never blocking on) projects already being processed by other
   * workers. Bumps `attempts` and moves the row to 'processing'. Returns null when
   * nothing is claimable.
   */
  claimNext(): Promise<QueueEvent | null>;

  /** Mark a claimed event successfully processed. */
  markDone(id: string): Promise<void>;

  /**
   * Record a failure. Transient failures below the attempt ceiling go back to
   * pending with a backoff delay; a permanent failure, or exhausting the ceiling,
   * moves the event to 'failed' (dead-letter) with `last_error` preserved so one
   * poison event can't block its project's queue forever.
   */
  markFailed(id: string, failure: FailureReport): Promise<FailureOutcome>;

  /**
   * Recover events stuck in 'processing' because their worker crashed (older than
   * `olderThanMs`). Those past the attempt ceiling are dead-lettered; the rest
   * return to pending. Returns how many rows were reclaimed.
   */
  reclaimStale(olderThanMs: number): Promise<number>;
}

/* ------------------------------- mapping store ------------------------------- */

export interface DiscordJiraMapping {
  readonly discordThreadId: string;
  readonly jiraIssueKey: string;
  readonly jiraIssueId: string;
  readonly createdAt: Date;
}

export interface InsertMappingInput {
  readonly discordThreadId: string;
  readonly jiraIssueKey: string;
  readonly jiraIssueId: string;
}

/**
 * The primary, strongly-consistent dedup store (design #4). `insert` relies on the
 * unique constraint and throws DuplicateMappingError on a second insert for the
 * same thread — the sync engine treats that as "already created", never a second
 * Story.
 */
export interface MappingStore {
  insert(input: InsertMappingInput): Promise<DiscordJiraMapping>;
  findByThreadId(discordThreadId: string): Promise<DiscordJiraMapping | null>;
}

/** Thrown by MappingStore.insert when the unique constraint rejects a duplicate. */
export class DuplicateMappingError extends Error {
  readonly discordThreadId: string;

  constructor(discordThreadId: string) {
    super(`A JIRA mapping already exists for Discord thread ${discordThreadId}`);
    this.name = 'DuplicateMappingError';
    this.discordThreadId = discordThreadId;
  }
}
