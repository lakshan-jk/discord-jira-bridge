/**
 * Integration tests against a REAL Postgres (not the in-memory fake), so we know the
 * actual SQL — the claim CTE with FOR UPDATE SKIP LOCKED, the partial unique index,
 * the parameterised inserts — works end to end.
 *
 * Requires a database at DATABASE_URL (default matches docker-compose.yml). Run:
 *   docker compose up -d
 *   npm run test:integration
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  createEventQueue,
  createMappingStore,
  DuplicateMappingError,
  migrate,
  type Db,
  type EventQueue,
  type MappingStore,
} from '../../src/db/index.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://jumeau:jumeau@localhost:5432/jumeau';

let db: Db;
let queue: EventQueue;
let mappings: MappingStore;

function enqueue(projectKey: string, eventType: string, maxAttempts?: number) {
  return queue.enqueue({
    projectKey,
    eventType,
    discordThreadId: `thread-${projectKey}`,
    payload: { type: eventType, projectKey },
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  });
}

async function statusOf(id: string): Promise<string | undefined> {
  const res = await db.query<{ status: string }>('SELECT status FROM event_queue WHERE id = $1', [
    id,
  ]);
  return res.rows[0]?.status;
}

beforeAll(async () => {
  db = createDb({ connectionString: DATABASE_URL });
  await migrate(db);
  queue = createEventQueue(db);
  mappings = createMappingStore(db);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('TRUNCATE event_queue, discord_jira_map RESTART IDENTITY');
});

describe('event queue — real SQL', () => {
  it('enqueues, claims, and completes an event', async () => {
    const { id } = await enqueue('CHK', 'thread_created');
    expect(await statusOf(id)).toBe('pending');

    const claimed = await queue.claimNext();
    expect(claimed?.id).toBe(id);
    expect(claimed?.status).toBe('processing');
    expect(claimed?.attempts).toBe(1);

    await queue.markDone(id);
    expect(await statusOf(id)).toBe('done');

    // Nothing left to claim.
    expect(await queue.claimNext()).toBeNull();
  });

  it('enforces per-project ordering while letting other projects proceed', async () => {
    const a1 = await enqueue('CHK', 'thread_created');
    const a2 = await enqueue('CHK', 'comment');
    const b1 = await enqueue('PAY', 'thread_created');

    // First claim: earliest overall -> CHK a1. CHK is now busy.
    expect((await queue.claimNext())?.id).toBe(a1.id);
    // Second claim: CHK is busy, so skip a2 and serve PAY b1.
    expect((await queue.claimNext())?.id).toBe(b1.id);
    // Third claim: both projects busy -> nothing claimable.
    expect(await queue.claimNext()).toBeNull();

    // Finishing a1 unblocks CHK, so a2 becomes claimable (in order).
    await queue.markDone(a1.id);
    expect((await queue.claimNext())?.id).toBe(a2.id);
  });

  it('never hands the same project to two concurrent claimers (partial unique index)', async () => {
    await enqueue('CHK', 'thread_created');
    await enqueue('CHK', 'comment');

    // Two claims race on the same project via separate pool connections. The
    // one-processing-per-project index guarantees exactly one wins; the loser gets
    // null (its 23505 is swallowed by claimNext), not a duplicate in-flight.
    const [first, second] = await Promise.all([queue.claimNext(), queue.claimNext()]);
    const claimed = [first, second].filter((e) => e !== null);
    expect(claimed).toHaveLength(1);
  });

  it('re-queues a transient failure with a future availability, dead-letters at the ceiling', async () => {
    const { id } = await enqueue('CHK', 'comment', 1);
    await queue.claimNext(); // attempts -> 1 (the ceiling)

    const outcome = await queue.markFailed(id, { kind: 'transient', message: 'boom' });
    expect(outcome.action).toBe('dead-letter');
    expect(await statusOf(id)).toBe('failed');
  });
});

describe('mapping store — real SQL', () => {
  it('inserts and finds a mapping', async () => {
    await mappings.insert({ discordThreadId: 't1', jiraIssueKey: 'CHK-1', jiraIssueId: '1001' });
    const found = await mappings.findByThreadId('t1');
    expect(found?.jiraIssueKey).toBe('CHK-1');
    expect(await mappings.findByThreadId('missing')).toBeNull();
  });

  it('rejects a duplicate insert loudly via the unique constraint', async () => {
    await mappings.insert({ discordThreadId: 't1', jiraIssueKey: 'CHK-1', jiraIssueId: '1001' });
    await expect(
      mappings.insert({ discordThreadId: 't1', jiraIssueKey: 'CHK-2', jiraIssueId: '1002' }),
    ).rejects.toBeInstanceOf(DuplicateMappingError);
    // Original is untouched.
    expect((await mappings.findByThreadId('t1'))?.jiraIssueKey).toBe('CHK-1');
  });
});
