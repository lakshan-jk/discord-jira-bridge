import { describe, expect, it } from 'vitest';
import { InMemoryEventQueue } from './memory.js';

/** A controllable clock so backoff/availability are deterministic. */
function clockFrom(start: number): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('claim ordering', () => {
  it('serves events within a project in FIFO order, one in flight at a time', async () => {
    const q = new InMemoryEventQueue();
    const a1 = await q.enqueue({ projectKey: 'CHK', eventType: 'story', discordThreadId: 't', payload: {} });
    await q.enqueue({ projectKey: 'CHK', eventType: 'comment', discordThreadId: 't', payload: {} });

    // First claim hands out the earliest event; the project is now busy.
    const first = await q.claimNext();
    expect(first?.id).toBe(a1.id);

    // While it is processing, the next CHK event is NOT handed out (ordering).
    expect(await q.claimNext()).toBeNull();

    // Once the first is done, the second becomes claimable.
    await q.markDone(a1.id);
    const second = await q.claimNext();
    expect(second?.eventType).toBe('comment');
  });

  it('lets different projects proceed in parallel without blocking each other', async () => {
    const q = new InMemoryEventQueue();
    await q.enqueue({ projectKey: 'CHK', eventType: 'story', discordThreadId: 'c', payload: {} });
    await q.enqueue({ projectKey: 'PAY', eventType: 'story', discordThreadId: 'p', payload: {} });

    const first = await q.claimNext();
    const second = await q.claimNext();

    // Two different projects can be in flight simultaneously.
    expect([first?.projectKey, second?.projectKey].sort()).toEqual(['CHK', 'PAY']);
  });

  it('does not hand out an event whose backoff has not yet elapsed', async () => {
    const clock = clockFrom(1_000_000);
    const q = new InMemoryEventQueue(clock.now);
    const e = await q.enqueue({ projectKey: 'CHK', eventType: 'story', discordThreadId: 't', payload: {} });

    const claimed = await q.claimNext();
    await q.markFailed(claimed!.id, { kind: 'transient', message: 'boom' });

    // Still within the backoff window: not claimable.
    expect(await q.claimNext()).toBeNull();

    // After the backoff elapses, it comes back.
    clock.advance(60_000);
    const retried = await q.claimNext();
    expect(retried?.id).toBe(e.id);
  });
});

describe('retry to dead-letter transition', () => {
  it('retries a transient failure until the ceiling, then dead-letters with last error preserved', async () => {
    const clock = clockFrom(0);
    const q = new InMemoryEventQueue(clock.now);
    const e = await q.enqueue({
      projectKey: 'CHK',
      eventType: 'story',
      discordThreadId: 't',
      payload: {},
      maxAttempts: 3,
    });

    // Attempts 1 and 2 retry.
    for (let i = 0; i < 2; i++) {
      const claimed = await q.claimNext();
      expect(claimed).not.toBeNull();
      const outcome = await q.markFailed(claimed!.id, { kind: 'transient', message: `fail ${i}` });
      expect(outcome.action).toBe('retry');
      clock.advance(10 * 60_000); // skip past backoff
    }

    // Third attempt exhausts the ceiling -> dead-letter.
    const last = await q.claimNext();
    const outcome = await q.markFailed(last!.id, { kind: 'transient', message: 'final failure' });
    expect(outcome.action).toBe('dead-letter');

    const dead = q.peek(e.id);
    expect(dead?.status).toBe('failed');
    expect(dead?.attempts).toBe(3);
    expect(dead?.lastError).toBe('final failure');

    // A dead-lettered event is never handed out again -> its project is unblocked.
    expect(await q.claimNext()).toBeNull();
  });

  it('sends a permanent failure straight to dead-letter on the first attempt', async () => {
    const q = new InMemoryEventQueue();
    const e = await q.enqueue({ projectKey: 'CHK', eventType: 'story', discordThreadId: 't', payload: {} });

    const claimed = await q.claimNext();
    const outcome = await q.markFailed(claimed!.id, { kind: 'permanent', message: '400 bad request' });

    expect(outcome.action).toBe('dead-letter');
    expect(q.peek(e.id)?.status).toBe('failed');
    expect(q.peek(e.id)?.attempts).toBe(1);
  });

  it('dead-letters a crashed (stale) event that has exhausted attempts', async () => {
    const clock = clockFrom(0);
    const q = new InMemoryEventQueue(clock.now);
    const e = await q.enqueue({
      projectKey: 'CHK',
      eventType: 'story',
      discordThreadId: 't',
      payload: {},
      maxAttempts: 1,
    });

    // Claim bumps attempts to 1 (the ceiling) then the "worker crashes" — no markX.
    await q.claimNext();
    clock.advance(10 * 60_000);

    const reclaimed = await q.reclaimStale(60_000);
    expect(reclaimed).toBe(1);
    expect(q.peek(e.id)?.status).toBe('failed');
  });
});
