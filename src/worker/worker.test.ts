import { describe, expect, it, vi } from 'vitest';
import { createWorker } from './worker.js';
import { InMemoryEventQueue } from '../db/memory.js';
import { PermanentJiraError, TransientJiraError } from '../lib/errors.js';
import type { SyncEngine, SyncResult } from '../sync/index.js';
import type { IngestedEvent } from '../discord/index.js';

const EVENT: IngestedEvent = {
  type: 'comment',
  projectKey: 'CHK',
  threadId: 'thread-1',
  authorDisplayName: 'Ada',
  occurredAt: new Date('2026-11-06T10:00:00Z'),
  source: 'gateway',
  messageId: 'm1',
  body: 'hello',
};

/** A fake engine with a scriptable handle(). */
function fakeEngine(impl: SyncEngine['handle']): SyncEngine {
  return { handle: vi.fn<SyncEngine['handle']>(impl) };
}

async function enqueueOne(queue: InMemoryEventQueue, maxAttempts?: number) {
  return queue.enqueue({
    projectKey: EVENT.projectKey,
    eventType: EVENT.type,
    discordThreadId: EVENT.threadId,
    payload: EVENT,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  });
}

describe('runOnce', () => {
  it('marks an event done when the engine returns a SyncResult', async () => {
    const queue = new InMemoryEventQueue();
    const { id } = await enqueueOne(queue);
    const engine = fakeEngine(() =>
      Promise.resolve({ outcome: 'commented', issueKey: 'CHK-1' } satisfies SyncResult),
    );
    const worker = createWorker({ queue, engine });

    expect(await worker.runOnce()).toBe('processed');
    expect(queue.peek(id)?.status).toBe('done');
    expect(engine.handle).toHaveBeenCalledWith(EVENT);
  });

  it('treats a business outcome (skip) as success, not a retry', async () => {
    const queue = new InMemoryEventQueue();
    const { id } = await enqueueOne(queue);
    const engine = fakeEngine(() =>
      Promise.resolve({ outcome: 'skipped', reason: 'project_not_found' } satisfies SyncResult),
    );
    const worker = createWorker({ queue, engine });

    await worker.runOnce();
    expect(queue.peek(id)?.status).toBe('done');
  });

  it('backs off and re-queues on a transient error', async () => {
    const clock = { t: 1_000_000 };
    const queue = new InMemoryEventQueue(() => clock.t);
    const { id } = await enqueueOne(queue); // default maxAttempts 5
    const engine = fakeEngine(() => Promise.reject(new TransientJiraError('503 upstream')));
    const worker = createWorker({ queue, engine });

    await worker.runOnce();

    const row = queue.peek(id)!;
    expect(row.status).toBe('pending'); // re-queued, not failed
    expect(row.attempts).toBe(1);
    expect(row.availableAt.getTime()).toBeGreaterThan(clock.t); // backoff in the future
    expect(row.lastError).toContain('503');
  });

  it('honours Retry-After from a transient error when backing off', async () => {
    const clock = { t: 0 };
    const queue = new InMemoryEventQueue(() => clock.t);
    const { id } = await enqueueOne(queue);
    const engine = fakeEngine(() =>
      Promise.reject(new TransientJiraError('429', { status: 429, retryAfterMs: 7_000 })),
    );
    const worker = createWorker({ queue, engine });

    await worker.runOnce();
    expect(queue.peek(id)?.availableAt.getTime()).toBe(7_000);
  });

  it('dead-letters immediately on a permanent error', async () => {
    const queue = new InMemoryEventQueue();
    const { id } = await enqueueOne(queue);
    const engine = fakeEngine(() => Promise.reject(new PermanentJiraError('400 bad request')));
    const worker = createWorker({ queue, engine });

    await worker.runOnce();

    const row = queue.peek(id)!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('400');
  });

  it('dead-letters a transient error once max attempts is reached', async () => {
    const queue = new InMemoryEventQueue();
    const { id } = await enqueueOne(queue, 1); // ceiling of one attempt
    const engine = fakeEngine(() => Promise.reject(new TransientJiraError('flaky')));
    const worker = createWorker({ queue, engine });

    await worker.runOnce(); // claim bumps attempts to 1, which equals the ceiling

    expect(queue.peek(id)?.status).toBe('failed');
  });

  it('returns idle when there is nothing to claim', async () => {
    const queue = new InMemoryEventQueue();
    const worker = createWorker({ queue, engine: fakeEngine(() => Promise.reject(new Error('x'))) });
    expect(await worker.runOnce()).toBe('idle');
  });
});

describe('loop + graceful shutdown', () => {
  it('drains all events, then stops cleanly on stop()', async () => {
    const queue = new InMemoryEventQueue();
    // Two events on the same project are processed in sequence.
    const a = await enqueueOne(queue);
    const b = await enqueueOne(queue);
    const engine = fakeEngine(() =>
      Promise.resolve({ outcome: 'commented', issueKey: 'CHK-1' } satisfies SyncResult),
    );
    const worker = createWorker({ queue, engine, idleSleepMs: 5 });

    const started = worker.start();
    await vi.waitFor(() => expect(engine.handle).toHaveBeenCalledTimes(2));
    await worker.stop();
    await started; // start() resolves only once the loop has fully stopped

    expect(queue.peek(a.id)?.status).toBe('done');
    expect(queue.peek(b.id)?.status).toBe('done');
  });

  it('finishes the in-flight event before shutting down', async () => {
    const queue = new InMemoryEventQueue();
    const { id } = await enqueueOne(queue);

    let release!: () => void;
    const inFlight = new Promise<void>((r) => (release = r));
    let entered = false;
    const engine = fakeEngine(async () => {
      entered = true;
      await inFlight; // hold the event mid-processing
      return { outcome: 'commented', issueKey: 'CHK-1' } satisfies SyncResult;
    });
    const worker = createWorker({ queue, engine, idleSleepMs: 5 });

    const started = worker.start();
    await vi.waitFor(() => expect(entered).toBe(true)); // engine is mid-flight
    const stopping = worker.stop(); // request shutdown while event is in flight

    release(); // let the engine finish
    await stopping;
    await started;

    // The in-flight event was settled, not lost.
    expect(queue.peek(id)?.status).toBe('done');
  });
});
