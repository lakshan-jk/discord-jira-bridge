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

const COMMAND_PREFIX = '/';
const RESYNC_COMMAND = '!resync';

/**
 * Recognize the channel-level `!resync` command. Unlike the per-issue `/status`
 * commands it uses a `!` prefix and takes no argument — it triggers a sweep of the
 * whole forum channel, so it is routed separately from normalization.
 */
export function isResyncCommand(content: string): boolean {
  return content.trim().toLowerCase() === RESYNC_COMMAND;
}

/**
 * Recognize a status command in a message body. Returns the target status name, or
 * null if the message is just a normal comment.
 *
 *   /status In Progress  -> "In Progress"
 *   /blocked             -> "blocked"
 *
 * The command token is case-insensitive; the target is preserved verbatim and
 * resolved against the issue's own workflow downstream (design #5).
 */
export function parseStatusCommand(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) {
    return null;
  }

  const withoutPrefix = trimmed.slice(COMMAND_PREFIX.length);
  const spaceIdx = withoutPrefix.indexOf(' ');
  const command = (spaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : withoutPrefix.slice(spaceIdx + 1).trim();

  if (command === 'status') {
    // A bare "/status" with no target isn't a command — treat as a comment.
    return rest.length > 0 ? rest : null;
  }
  if (command === 'blocked') {
    return 'blocked';
  }
  return null;
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
