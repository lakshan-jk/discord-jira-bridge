import { describe, expect, it } from 'vitest';
import { InMemoryEventQueue } from '../db/memory.js';
import { Ingestor } from './ingestor.js';
import type { BackfillQuery, DiscordGateway, RawMessage, RawThread } from './types.js';

/** A fake gateway backed by in-memory fixtures — no live Discord. */
class FakeGateway implements DiscordGateway {
  threadHandler?: (t: RawThread) => Promise<void>;
  messageHandler?: (m: RawMessage) => Promise<void>;

  constructor(
    private readonly threads: RawThread[],
    private readonly messagesByThread: Record<string, RawMessage[]>,
  ) {}

  onThreadCreated(handler: (t: RawThread) => Promise<void>): void {
    this.threadHandler = handler;
  }
  onMessageCreated(handler: (m: RawMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  listThreads(query: BackfillQuery): Promise<readonly RawThread[]> {
    const visible = query.includeArchived ? this.threads : this.threads.filter((t) => !t.archived);
    return Promise.resolve(visible);
  }
  listMessages(threadId: string): Promise<readonly RawMessage[]> {
    return Promise.resolve(this.messagesByThread[threadId] ?? []);
  }
}

const RECENT = new Date('2026-11-06T12:00:00Z');
const OLD = new Date('2026-01-01T00:00:00Z');
const CUTOFF = new Date('2026-11-01T00:00:00Z');

function thread(id: string, createdAt: Date, over: Partial<RawThread> = {}): RawThread {
  return {
    id,
    name: `Post ${id}`,
    parentChannelName: 'proj-checkout',
    createdAt,
    archived: false,
    ownerDisplayName: 'Ada',
    starterMessageContent: 'body',
    ...over,
  };
}

function msg(id: string, threadId: string, createdAt: Date, over: Partial<RawMessage> = {}): RawMessage {
  return {
    id,
    threadId,
    parentChannelName: 'proj-checkout',
    author: { id: 'u1', displayName: 'Ada', isBot: false },
    content: `message ${id}`,
    createdAt,
    isSystem: false,
    isThreadStarter: false,
    ...over,
  };
}

describe('backfill', () => {
  it('enqueues thread_created before its comments, in order', async () => {
    const t = thread('t1', RECENT);
    const gateway = new FakeGateway([t], {
      t1: [msg('m1', 't1', RECENT), msg('m2', 't1', RECENT)],
    });
    const queue = new InMemoryEventQueue();
    await new Ingestor({ gateway, queue }).backfill({ cutoff: CUTOFF, includeArchived: false });

    const events = await drain(queue);
    expect(events.map((e) => (e.payload as { type: string }).type)).toEqual([
      'thread_created',
      'comment',
      'comment',
    ]);
  });

  it('respects the cutoff: a dormant old thread is skipped entirely', async () => {
    const recentT = thread('t1', RECENT);
    const oldDormant = thread('t2', OLD);
    const gateway = new FakeGateway([recentT, oldDormant], {
      t1: [msg('m1', 't1', RECENT)],
      t2: [msg('m-old', 't2', OLD)], // all activity predates the cutoff
    });
    const queue = new InMemoryEventQueue();
    await new Ingestor({ gateway, queue }).backfill({ cutoff: CUTOFF, includeArchived: false });

    const events = await drain(queue);
    const threadIds = new Set(events.map((e) => (e.payload as { threadId: string }).threadId));
    expect(threadIds).toEqual(new Set(['t1'])); // t2 never enqueued
  });

  it('brings in an old thread that has recent activity, create first, only recent messages', async () => {
    const oldActive = thread('t2', OLD);
    const gateway = new FakeGateway([oldActive], {
      t2: [msg('m-old', 't2', OLD), msg('m-new', 't2', RECENT)],
    });
    const queue = new InMemoryEventQueue();
    await new Ingestor({ gateway, queue }).backfill({ cutoff: CUTOFF, includeArchived: false });

    const events = await drain(queue);
    const types = events.map((e) => (e.payload as { type: string }).type);
    expect(types).toEqual(['thread_created', 'comment']); // old message excluded
    expect((events[1]!.payload as { messageId: string }).messageId).toBe('m-new');
  });

  it('excludes archived threads unless includeArchived is set', async () => {
    const archived = thread('t3', RECENT, { archived: true });
    const gateway = new FakeGateway([archived], { t3: [] });

    const q1 = new InMemoryEventQueue();
    await new Ingestor({ gateway, queue: q1 }).backfill({ cutoff: CUTOFF, includeArchived: false });
    expect(await drain(q1)).toHaveLength(0);

    const q2 = new InMemoryEventQueue();
    await new Ingestor({ gateway, queue: q2 }).backfill({ cutoff: CUTOFF, includeArchived: true });
    expect(await drain(q2)).toHaveLength(1);
  });

  it('never enqueues bot or system messages', async () => {
    const t = thread('t1', RECENT);
    const gateway = new FakeGateway([t], {
      t1: [
        msg('m-bot', 't1', RECENT, { author: { id: 'b', displayName: 'Bot', isBot: true } }),
        msg('m-sys', 't1', RECENT, { isSystem: true }),
        msg('m-ok', 't1', RECENT),
      ],
    });
    const queue = new InMemoryEventQueue();
    await new Ingestor({ gateway, queue }).backfill({ cutoff: CUTOFF, includeArchived: false });

    const events = await drain(queue);
    // thread_created + the one real comment only.
    expect(events.map((e) => (e.payload as { type: string }).type)).toEqual([
      'thread_created',
      'comment',
    ]);
  });
});

describe('real-time gateway path', () => {
  it('normalizes and enqueues a new thread and a new message', async () => {
    const gateway = new FakeGateway([], {});
    const queue = new InMemoryEventQueue();
    await new Ingestor({ gateway, queue }).start();

    await gateway.threadHandler!(thread('t9', RECENT));
    await gateway.messageHandler!(msg('m9', 't9', RECENT, { content: '/status Done' }));

    const events = await drain(queue);
    expect(events.map((e) => (e.payload as { type: string }).type)).toEqual([
      'thread_created',
      'status_command',
    ]);
  });
});

/** Claim every event out of the queue in order, marking each done. */
async function drain(queue: InMemoryEventQueue) {
  const out = [];
  for (;;) {
    const event = await queue.claimNext();
    if (!event) break;
    out.push(event);
    await queue.markDone(event.id);
  }
  return out;
}
