/**
 * Ingestion orchestrator.
 *
 * Its only job is normalize-and-enqueue: turn raw Discord payloads (from either the
 * live gateway or the startup backfill) into the internal event shape and persist
 * them durably to the queue. It never calls JIRA — that separation is what lets the
 * queue guarantee at-least-once and survive restarts.
 *
 * discord.js-free and JIRA-free, so it is unit-testable with a fake gateway and the
 * in-memory queue.
 */

import type { EventQueue } from '../db/index.js';
import { normalizeMessage, normalizeThreadCreated, toEnqueueInput } from './normalize.js';
import type { DiscordGateway, IngestedEvent, RawMessage, RawThread } from './types.js';

/** Minimal log surface; defaults to console. Kept injectable for tests. */
export interface IngestLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

const noopLogger: IngestLogger = {
  info: () => {},
  debug: () => {},
};

export interface BackfillOptions {
  /** Lower time bound: only threads/messages at or after this instant are ingested. */
  readonly cutoff: Date;
  readonly includeArchived: boolean;
}

export interface IngestorDeps {
  readonly gateway: DiscordGateway;
  readonly queue: EventQueue;
  readonly logger?: IngestLogger;
}

export class Ingestor {
  private readonly gateway: DiscordGateway;
  private readonly queue: EventQueue;
  private readonly log: IngestLogger;

  constructor(deps: IngestorDeps) {
    this.gateway = deps.gateway;
    this.queue = deps.queue;
    this.log = deps.logger ?? noopLogger;
  }

  /** Wire real-time gateway handlers and connect. */
  async start(): Promise<void> {
    this.gateway.onThreadCreated(async (thread) => {
      await this.ingestThread(thread, 'gateway');
    });
    this.gateway.onMessageCreated(async (message) => {
      await this.ingestMessage(message, 'gateway');
    });
    await this.gateway.start();
    this.log.info('discord ingestion started');
  }

  async stop(): Promise<void> {
    await this.gateway.stop();
  }

  /**
   * Bounded historical backfill (design #7). For each in-scope thread we enqueue its
   * thread_created event FIRST, then its messages oldest-first — preserving the
   * "Story exists before its comments" invariant and per-thread ordering.
   */
  async backfill(options: BackfillOptions): Promise<void> {
    const threads = await this.gateway.listThreads({ includeArchived: options.includeArchived });

    // Process threads oldest-first so earlier milestones are enqueued first.
    const ordered = [...threads].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    let enqueued = 0;
    for (const thread of ordered) {
      const messages = await this.gateway.listMessages(thread.id);
      const recentMessages = messages.filter((m) => m.createdAt.getTime() >= options.cutoff.getTime());

      // A thread is in scope if it was itself created after the cutoff, or has any
      // activity after the cutoff. Old, dormant threads are skipped — that is the
      // bound that stops a first-boot flood of JIRA writes.
      const inScope =
        thread.createdAt.getTime() >= options.cutoff.getTime() || recentMessages.length > 0;
      if (!inScope) {
        continue;
      }

      // Always enqueue the create first so the Story exists before any comment on it,
      // even for an older thread brought in by recent activity (dedup makes the
      // re-create safe on restart).
      if (await this.ingestThread(thread, 'backfill')) {
        enqueued += 1;
      }
      for (const message of recentMessages) {
        if (await this.ingestMessage(message, 'backfill')) {
          enqueued += 1;
        }
      }
    }
    this.log.info('backfill complete', { threads: ordered.length, enqueued });
  }

  private async ingestThread(thread: RawThread, source: IngestedEvent['source']): Promise<boolean> {
    const event = normalizeThreadCreated(thread, source);
    if (!event) {
      this.log.debug('dropped thread', { threadId: thread.id, parent: thread.parentChannelName });
      return false;
    }
    await this.enqueue(event);
    return true;
  }

  private async ingestMessage(
    message: RawMessage,
    source: IngestedEvent['source'],
  ): Promise<boolean> {
    const event = normalizeMessage(message, source);
    if (!event) {
      this.log.debug('dropped message', { messageId: message.id });
      return false;
    }
    await this.enqueue(event);
    return true;
  }

  private async enqueue(event: IngestedEvent): Promise<void> {
    await this.queue.enqueue(toEnqueueInput(event));
    this.log.debug('enqueued event', {
      type: event.type,
      projectKey: event.projectKey,
      threadId: event.threadId,
    });
  }
}
