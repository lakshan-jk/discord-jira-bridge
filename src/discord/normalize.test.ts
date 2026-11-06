import { describe, expect, it } from 'vitest';
import {
  isResyncCommand,
  normalizeMessage,
  normalizeThreadCreated,
  parseStatusCommand,
} from './normalize.js';
import type { RawMessage, RawThread } from './types.js';

const AT = new Date('2026-11-06T10:00:00Z');

function thread(overrides: Partial<RawThread> = {}): RawThread {
  return {
    id: 'thread-1',
    name: 'Checkout is broken',
    parentChannelName: 'proj-checkout',
    createdAt: AT,
    archived: false,
    ownerDisplayName: 'Ada',
    starterMessageContent: 'The checkout button does nothing.',
    ...overrides,
  };
}

function message(overrides: Partial<RawMessage> = {}): RawMessage {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    parentChannelName: 'proj-checkout',
    author: { id: 'u1', displayName: 'Ada', isBot: false },
    content: 'Looking into it now.',
    createdAt: AT,
    isSystem: false,
    isThreadStarter: false,
    ...overrides,
  };
}

describe('normalizeThreadCreated', () => {
  it('turns a forum post into a thread_created event with derived project key', () => {
    const event = normalizeThreadCreated(thread(), 'gateway');
    expect(event).toMatchObject({
      type: 'thread_created',
      projectKey: 'CHECKOUT',
      threadId: 'thread-1',
      title: 'Checkout is broken',
      body: 'The checkout button does nothing.',
      authorDisplayName: 'Ada',
      source: 'gateway',
    });
  });

  it('drops a thread with no forum parent or an unmappable channel', () => {
    expect(normalizeThreadCreated(thread({ parentChannelName: null }), 'gateway')).toBeNull();
    expect(normalizeThreadCreated(thread({ parentChannelName: 'proj-' }), 'gateway')).toBeNull();
  });
});

describe('normalizeMessage', () => {
  it('turns a plain message into a comment event', () => {
    const event = normalizeMessage(message(), 'backfill');
    expect(event).toMatchObject({
      type: 'comment',
      projectKey: 'CHECKOUT',
      threadId: 'thread-1',
      body: 'Looking into it now.',
      messageId: 'msg-1',
      source: 'backfill',
    });
  });

  it('recognizes a status command', () => {
    const event = normalizeMessage(message({ content: '/status In Progress' }), 'gateway');
    expect(event).toMatchObject({ type: 'status_command', targetStatus: 'In Progress' });
  });

  it('drops bot, system, starter, and empty messages', () => {
    expect(normalizeMessage(message({ author: { id: 'b', displayName: 'Bot', isBot: true } }), 'gateway')).toBeNull();
    expect(normalizeMessage(message({ isSystem: true }), 'gateway')).toBeNull();
    expect(normalizeMessage(message({ isThreadStarter: true }), 'gateway')).toBeNull();
    expect(normalizeMessage(message({ content: '   ' }), 'gateway')).toBeNull();
  });
});

describe('parseStatusCommand', () => {
  it('parses /status with a target and /blocked', () => {
    expect(parseStatusCommand('/status Done')).toBe('Done');
    expect(parseStatusCommand('/STATUS in review')).toBe('in review');
    expect(parseStatusCommand('/blocked')).toBe('blocked');
  });

  it('treats non-commands and bare /status as comments (null)', () => {
    expect(parseStatusCommand('just a comment')).toBeNull();
    expect(parseStatusCommand('/status')).toBeNull();
    expect(parseStatusCommand('/unknown thing')).toBeNull();
  });
});

describe('isResyncCommand', () => {
  it('recognizes !resync (case-insensitive, trimmed)', () => {
    expect(isResyncCommand('!resync')).toBe(true);
    expect(isResyncCommand('  !ReSync  ')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isResyncCommand('!resync now')).toBe(false);
    expect(isResyncCommand('resync')).toBe(false);
    expect(isResyncCommand('/status Done')).toBe(false);
  });
});
