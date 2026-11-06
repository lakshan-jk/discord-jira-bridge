/**
 * PostgreSQL-backed event queue. Parameterised queries throughout.
 *
 * Per-project ordering is enforced by two cooperating mechanisms:
 *   1. The claim query filters out any project that already has a 'processing' row
 *      (NOT EXISTS) and takes the earliest pending row by id — this is the common
 *      path and keeps throughput up by never blocking other projects.
 *   2. `FOR UPDATE SKIP LOCKED` means concurrent workers lock different rows instead
 *      of colliding or waiting on each other.
 *   3. The partial unique index `event_queue_one_processing_per_project` is the hard
 *      backstop: if two workers both pass the NOT EXISTS check for the same project
 *      in the same instant, the second UPDATE to 'processing' violates the index and
 *      that claim aborts — so "one in flight per project" is guaranteed.
 */

import type { Db } from './client.js';
import { backoffDelayMs, decideFailure } from './retry-policy.js';
import type {
  EnqueueInput,
  EventQueue,
  FailureOutcome,
  FailureReport,
  QueueEvent,
} from './types.js';

interface EventRow {
  id: string;
  project_key: string;
  event_type: string;
  discord_thread_id: string;
  payload: unknown;
  status: QueueEvent['status'];
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  available_at: Date;
  created_at: Date;
  updated_at: Date;
}

const PG_UNIQUE_VIOLATION = '23505';

function rowToEvent(row: EventRow): QueueEvent {
  return {
    id: row.id,
    projectKey: row.project_key,
    eventType: row.event_type,
    discordThreadId: row.discord_thread_id,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    availableAt: row.available_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createEventQueue(db: Db): EventQueue {
  return new PgEventQueue(db);
}

class PgEventQueue implements EventQueue {
  constructor(private readonly db: Db) {}

  async enqueue(input: EnqueueInput): Promise<QueueEvent> {
    const res = await this.db.query<EventRow>(
      `INSERT INTO event_queue
         (project_key, event_type, discord_thread_id, payload, max_attempts)
       VALUES ($1, $2, $3, $4, COALESCE($5, 5))
       RETURNING *`,
      [
        input.projectKey,
        input.eventType,
        input.discordThreadId,
        JSON.stringify(input.payload),
        input.maxAttempts ?? null,
      ],
    );
    return rowToEvent(res.rows[0]!);
  }

  async claimNext(): Promise<QueueEvent | null> {
    // Single atomic statement: the CTE locks the chosen row (SKIP LOCKED), the
    // UPDATE flips it to 'processing' and bumps attempts. Bumping at claim time
    // means even a crash mid-processing consumes an attempt, so a worker-killing
    // poison event still converges on dead-letter (via reclaimStale).
    try {
      const res = await this.db.query<EventRow>(
        `WITH next AS (
           SELECT e.id
           FROM event_queue e
           WHERE e.status = 'pending'
             AND e.available_at <= now()
             AND NOT EXISTS (
               SELECT 1 FROM event_queue p
               WHERE p.project_key = e.project_key
                 AND p.status = 'processing'
             )
           ORDER BY e.id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE event_queue
         SET status = 'processing',
             attempts = attempts + 1,
             updated_at = now()
         WHERE id = (SELECT id FROM next)
         RETURNING *`,
      );
      const row = res.rows[0];
      return row ? rowToEvent(row) : null;
    } catch (err) {
      // Lost a race: another worker passed the NOT EXISTS check for the same
      // project in the same instant and committed 'processing' first, so our UPDATE
      // violated the one-processing-per-project partial unique index. That's the
      // backstop doing its job — there is simply nothing for us to claim right now.
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        return null;
      }
      throw err;
    }
  }

  async markDone(id: string): Promise<void> {
    await this.db.query(
      `UPDATE event_queue
       SET status = 'done', updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  async markFailed(id: string, failure: FailureReport): Promise<FailureOutcome> {
    // Read current attempt count to apply the policy. The row is 'processing' and
    // owned by this worker, so no other worker will touch it concurrently.
    const current = await this.db.query<{ attempts: number; max_attempts: number }>(
      `SELECT attempts, max_attempts FROM event_queue WHERE id = $1`,
      [id],
    );
    const found = current.rows[0];
    if (!found) {
      throw new Error(`markFailed: event ${id} not found`);
    }

    const decision = decideFailure({
      attempts: found.attempts,
      maxAttempts: found.max_attempts,
      kind: failure.kind,
    });

    if (decision === 'dead-letter') {
      await this.db.query(
        `UPDATE event_queue
         SET status = 'failed', last_error = $2, updated_at = now()
         WHERE id = $1`,
        [id, failure.message],
      );
      return { action: 'dead-letter', attempts: found.attempts };
    }

    const delayMs = backoffDelayMs(found.attempts, failure.retryAfterMs);
    const res = await this.db.query<{ available_at: Date }>(
      `UPDATE event_queue
       SET status = 'pending',
           last_error = $2,
           available_at = now() + make_interval(secs => $3),
           updated_at = now()
       WHERE id = $1
       RETURNING available_at`,
      [id, failure.message, delayMs / 1000],
    );
    return { action: 'retry', availableAt: res.rows[0]!.available_at, attempts: found.attempts };
  }

  async reclaimStale(olderThanMs: number): Promise<number> {
    // Crashed workers leave rows stuck in 'processing'. Past the attempt ceiling
    // they go to dead-letter; otherwise back to pending for another worker.
    const res = await this.db.query(
      `UPDATE event_queue
       SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
           last_error = CASE WHEN attempts >= max_attempts
                             THEN 'dead-lettered after stale processing (worker crash?)'
                             ELSE last_error END,
           updated_at = now()
       WHERE status = 'processing'
         AND updated_at < now() - make_interval(secs => $1)`,
      [olderThanMs / 1000],
    );
    return res.rowCount ?? 0;
  }
}
