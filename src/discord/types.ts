/**
 * Types for the Discord ingestion layer.
 *
 * Three groups:
 *  - Raw*  : the thin, discord.js-free view of a payload. The gateway boundary
 *            (gateway.ts) extracts these from discord.js objects; everything else
 *            works against them, so normalization is testable with plain objects.
 *  - Ingested* : the single normalized internal event shape. The sync engine only
 *            ever sees these and cannot tell whether an event came from the live
 *            gateway or the startup backfill.
 *  - DiscordGateway : the port the ingestor depends on, implemented by discord.js
 *            in gateway.ts and faked in tests.
 */

/* --------------------------------- raw inputs --------------------------------- */

export interface RawAuthor {
  readonly id: string;
  readonly displayName: string;
  /** discord.js `author.bot` — bot messages are dropped at this layer. */
  readonly isBot: boolean;
}

/** A forum post (= thread = milestone = Story). */
export interface RawThread {
  readonly id: string;
  /** Forum post title -> Story summary. */
  readonly name: string;
  /** Name of the parent forum channel -> JIRA project key. Null if not a forum. */
  readonly parentChannelName: string | null;
  readonly createdAt: Date;
  readonly archived: boolean;
  readonly ownerDisplayName: string;
  /** The post's first message body -> Story description. */
  readonly starterMessageContent: string;
}

/** A message posted inside a forum thread. */
export interface RawMessage {
  readonly id: string;
  readonly threadId: string;
  readonly parentChannelName: string | null;
  readonly author: RawAuthor;
  readonly content: string;
  readonly createdAt: Date;
  /** discord.js system message (joins, pins, …) — dropped at this layer. */
  readonly isSystem: boolean;
  /** True when this message is the thread's starter post (already captured by the
      thread_created event) — dropped so it isn't double-counted as a comment. */
  readonly isThreadStarter: boolean;
}

/* ------------------------------ normalized output ----------------------------- */

export type IngestSource = 'gateway' | 'backfill';
export type IngestedEventType = 'thread_created' | 'comment' | 'status_command';

interface BaseIngestedEvent {
  /** JIRA project key derived from the channel name (design #3). */
  readonly projectKey: string;
  /** Discord thread (forum post) id — the per-thread ordering/idempotency key. */
  readonly threadId: string;
  readonly authorDisplayName: string;
  /** Original Discord timestamp; defines ordering within a thread. */
  readonly occurredAt: Date;
  /** Provenance, for observability only — the sync engine ignores it. */
  readonly source: IngestSource;
}

/** A new forum post -> create a Story. */
export interface ThreadCreatedEvent extends BaseIngestedEvent {
  readonly type: 'thread_created';
  readonly title: string;
  readonly body: string;
}

/** A message -> add a comment. */
export interface CommentEvent extends BaseIngestedEvent {
  readonly type: 'comment';
  readonly messageId: string;
  readonly body: string;
}

/** A recognized status command -> transition the issue. */
export interface StatusCommandEvent extends BaseIngestedEvent {
  readonly type: 'status_command';
  readonly messageId: string;
  /** Target status name, resolved against the issue's workflow downstream. */
  readonly targetStatus: string;
  readonly rawBody: string;
}

export type IngestedEvent = ThreadCreatedEvent | CommentEvent | StatusCommandEvent;

/* --------------------------------- gateway port -------------------------------- */

export interface BackfillQuery {
  readonly includeArchived: boolean;
}

/**
 * The thin boundary over discord.js. The live implementation lives in gateway.ts;
 * tests supply a fake. Everything above this port is discord.js-free.
 */
export interface DiscordGateway {
  /** Register a handler for newly created forum threads (real-time). */
  onThreadCreated(handler: (thread: RawThread) => Promise<void>): void;
  /** Register a handler for new messages in forum threads (real-time). */
  onMessageCreated(handler: (message: RawMessage) => Promise<void>): void;

  /** Connect and begin emitting events. */
  start(): Promise<void>;
  /** Disconnect. */
  stop(): Promise<void>;

  /** Enumerate forum threads for backfill. */
  listThreads(query: BackfillQuery): Promise<readonly RawThread[]>;
  /** Fetch a thread's messages, oldest-first, for backfill. */
  listMessages(threadId: string): Promise<readonly RawMessage[]>;
}
