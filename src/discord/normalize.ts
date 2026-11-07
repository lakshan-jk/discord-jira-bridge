/**
 * Pure normalization: raw Discord payloads -> the single internal event shape (or
 * null when the payload should be dropped before it ever reaches the queue). No
 * discord.js, no I/O — this is the unit-tested core of the ingestion layer.
 */

import type { EnqueueInput } from '../db/index.js';
import { channelNameToProjectKey } from './mapper.js';
import type {
  CommentEvent,
  IngestSource,
  IngestedEvent,
  RawMessage,
  RawThread,
  StatusCommandEvent,
  ThreadCreatedEvent,
} from './types.js';

const RESYNC_COMMAND = '!resync';

/**
 * Recognize the channel-level `!resync` command. Unlike the per-issue `status:`
 * marker it uses a `!` prefix and takes no argument — it triggers a sweep of the
 * whole forum channel, so it is routed separately from normalization.
 */
export function isResyncCommand(content: string): boolean {
  return content.trim().toLowerCase() === RESYNC_COMMAND;
}

/**
 * Keyword -> target the sync engine acts on. `blocked` is a sentinel the engine
 * turns into a label + comment (design #5); the others are canonical JIRA status
 * names resolved against the issue's own workflow downstream.
 */
const STATUS_KEYWORDS: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
  blocked: 'blocked',
};

/**
 * Detect a `status: <keyword>` marker ANYWHERE in a message body, so it works in
 * natural sentences, not just at the start:
 *
 *   status: done                     -> "Done"
 *   wrapping up, status: in_progress  -> "In Progress"
 *   status: blocked                  -> "blocked"  (engine applies a label)
 *
 * Returns the mapped target, or null if the message carries no recognized marker
 * (a normal comment). The keyword and the `status:` token are case-insensitive;
 * `in_progress` also accepts a space or hyphen ("in progress", "in-progress").
 */
const STATUS_MARKER = /status:\s*(todo|in[\s_-]progress|done|blocked)\b/i;

export function parseStatusCommand(content: string): string | null {
  const match = STATUS_MARKER.exec(content);
  if (!match?.[1]) {
    return null;
  }
  // Normalize the captured keyword: lowercase, collapse space/hyphen to underscore.
  const keyword = match[1].toLowerCase().replace(/[\s-]+/g, '_');
  return STATUS_KEYWORDS[keyword] ?? null;
}

/**
 * A new forum post -> a thread_created event, or null if the thread can't be mapped
 * (not under a forum channel, or an unmappable channel name). The caller (ingestor)
 * logs the skip.
 */
export function normalizeThreadCreated(
  thread: RawThread,
  source: IngestSource,
): ThreadCreatedEvent | null {
  if (thread.parentChannelName === null) {
    return null;
  }
  const projectKey = channelNameToProjectKey(thread.parentChannelName);
  if (projectKey === null) {
    return null;
  }

  return {
    type: 'thread_created',
    projectKey,
    threadId: thread.id,
    authorDisplayName: thread.ownerDisplayName,
    occurredAt: thread.createdAt,
    source,
    title: thread.name,
    body: thread.starterMessageContent,
  };
}

/**
 * A message -> a comment or status_command event, or null if it should be dropped:
 * bot message, system message, the thread's starter post (already captured by
 * thread_created), empty content, or an unmappable channel.
 */
export function normalizeMessage(
  message: RawMessage,
  source: IngestSource,
): CommentEvent | StatusCommandEvent | null {
  if (message.author.isBot || message.isSystem || message.isThreadStarter) {
    return null;
  }
  if (message.parentChannelName === null) {
    return null;
  }

  const trimmed = message.content.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const projectKey = channelNameToProjectKey(message.parentChannelName);
  if (projectKey === null) {
    return null;
  }

  const base = {
    projectKey,
    threadId: message.threadId,
    authorDisplayName: message.author.displayName,
    occurredAt: message.createdAt,
    source,
    messageId: message.id,
  };

  const targetStatus = parseStatusCommand(message.content);
  if (targetStatus !== null) {
    return { ...base, type: 'status_command', targetStatus, rawBody: message.content };
  }
  return { ...base, type: 'comment', body: message.content };
}

/**
 * Adapt a normalized event to the queue's EnqueueInput. The whole event is carried
 * as the payload so the sync engine has everything it needs; `eventType` mirrors
 * the discriminant.
 */
export function toEnqueueInput(event: IngestedEvent): EnqueueInput {
  return {
    projectKey: event.projectKey,
    eventType: event.type,
    discordThreadId: event.threadId,
    payload: event,
  };
}
