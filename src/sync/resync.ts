/**
 * Channel resync (!resync command).
 *
 * Sweeps every thread in a forum channel and ensures each has a JIRA Story by
 * running it through the SAME idempotent create path the engine already uses for
 * thread_created events — so it only creates the missing Stories and never touches
 * existing ones — then replies in the channel with a summary.
 *
 * Depends only on the SyncEngine and a narrow Discord port (list threads + send a
 * message), so it is testable with a fake gateway and the in-memory stores.
 */

import { channelNameToProjectKey } from '../discord/index.js';
import { normalizeThreadCreated } from '../discord/normalize.js';
import type { BackfillQuery, RawThread } from '../discord/index.js';
import type { SyncEngine } from './types.js';

export interface ResyncLogger {
  info(message: string, meta?: Record<string, unknown>): void;
}

/** The slice of the Discord gateway resync needs. */
export interface ResyncGateway {
  listThreads(query: BackfillQuery): Promise<readonly RawThread[]>;
  sendMessage(channelId: string, content: string): Promise<void>;
}

export interface ResyncRequest {
  /** Forum channel name the command was issued in (-> project key). */
  readonly channelName: string;
  /** Channel/thread id to post the summary reply into. */
  readonly replyChannelId: string;
}

export interface ResyncSummary {
  readonly channelName: string;
  readonly projectKey: string | null;
  /** Threads examined. */
  readonly checked: number;
  /** Stories newly created. */
  readonly created: number;
  /** Threads that already had a Story (DB mapping or JIRA marker). */
  readonly alreadySynced: number;
  /** Threads that couldn't be synced (e.g. project not found). */
  readonly skipped: number;
}

export interface Resyncer {
  resync(request: ResyncRequest): Promise<ResyncSummary>;
}

export interface ResyncerDeps {
  readonly gateway: ResyncGateway;
  readonly engine: SyncEngine;
  readonly logger?: ResyncLogger;
}

const noopLogger: ResyncLogger = { info: () => {} };

export function createResyncer(deps: ResyncerDeps): Resyncer {
  return new ResyncerImpl(deps.gateway, deps.engine, deps.logger ?? noopLogger);
}

class ResyncerImpl implements Resyncer {
  constructor(
    private readonly gateway: ResyncGateway,
    private readonly engine: SyncEngine,
    private readonly log: ResyncLogger,
  ) {}

  async resync(request: ResyncRequest): Promise<ResyncSummary> {
    const projectKey = channelNameToProjectKey(request.channelName);

    // All forum threads, then just this channel's. Include archived so a full
    // resync covers dormant milestones too.
    const all = await this.gateway.listThreads({ includeArchived: true });
    const threads = all.filter((t) => t.parentChannelName === request.channelName);

    let created = 0;
    let alreadySynced = 0;
    let skipped = 0;

    for (const thread of threads) {
      const event = normalizeThreadCreated(thread, 'resync');
      if (!event) {
        skipped += 1;
        continue;
      }
      // Reuse the engine's idempotent create path: creates only when both the DB
      // mapping and the JIRA marker are absent; otherwise reports a dedup.
      const result = await this.engine.handle(event);
      switch (result.outcome) {
        case 'created':
          created += 1;
          break;
        case 'deduped':
          alreadySynced += 1;
          break;
        default:
          skipped += 1;
          break;
      }
    }

    const summary: ResyncSummary = {
      channelName: request.channelName,
      projectKey,
      checked: threads.length,
      created,
      alreadySynced,
      skipped,
    };

    this.log.info('resync complete', { ...summary });
    await this.gateway.sendMessage(request.replyChannelId, formatSummary(summary));
    return summary;
  }
}

/** Human-readable summary posted back to the channel. */
export function formatSummary(s: ResyncSummary): string {
  if (s.checked === 0) {
    return `🔄 Resync: no threads found in this channel (${s.channelName}).`;
  }
  const project = s.projectKey ?? '(unmapped channel)';
  const parts = [
    `checked ${s.checked} thread${s.checked === 1 ? '' : 's'}`,
    `created ${s.created}`,
    `already synced ${s.alreadySynced}`,
  ];
  if (s.skipped > 0) {
    parts.push(`skipped ${s.skipped}`);
  }
  return `🔄 Resync of **${project}** complete — ${parts.join(', ')}.`;
}
