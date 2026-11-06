/**
 * The worker: the runtime that actually drives the system.
 *
 * It claims pending events from the Postgres queue one at a time (per-project
 * ordering is already enforced by the queue's claim query), hands each to the sync
 * engine, and settles it — markDone on a returned SyncResult, markFailed on a
 * thrown error. The retry/backoff/dead-letter decision lives in the queue
 * (markFailed + the shared retry policy); the worker only classifies the error.
 *
 * Depends only on the EventQueue and SyncEngine interfaces, so it is unit-testable
 * with the in-memory queue and a fake engine.
 */

import { JiraError, TransientJiraError } from '../lib/errors.js';
import type { EventQueue, FailureReport, QueueEvent } from '../db/index.js';
import type { SyncEngine } from '../sync/index.js';
import type { IngestedEvent } from '../discord/index.js';

export interface WorkerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

const noopLogger: WorkerLogger = {
  info: () => {},
  warn: () => {},
};

const DEFAULT_IDLE_SLEEP_MS = 1_000;

export interface WorkerDeps {
  readonly queue: EventQueue;
  readonly engine: SyncEngine;
  readonly logger?: WorkerLogger;
  readonly idleSleepMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Worker {
  start(): Promise<void>;
  stop(): Promise<void>;
  runOnce(): Promise<'processed' | 'idle'>;
}

export function createWorker(deps: WorkerDeps): Worker {
  return new WorkerImpl(deps);
}

/**
 * Classify a thrown error for the queue's retry policy. A JiraError carries its own
 * transient/permanent kind (and a Retry-After for 429s); anything else is treated
 * as transient so it retries and is bounded by max-attempts rather than lost.
 */
function toFailureReport(err: unknown): FailureReport {
  if (err instanceof JiraError) {
    if (err instanceof TransientJiraError && err.retryAfterMs !== undefined) {
      return { kind: 'transient', message: err.message, retryAfterMs: err.retryAfterMs };
    }
    return { kind: err.kind, message: err.message };
  }
  return { kind: 'transient', message: err instanceof Error ? err.message : String(err) };
}

class WorkerImpl implements Worker {
  private readonly queue: EventQueue;
  private readonly engine: SyncEngine;
  private readonly log: WorkerLogger;
  private readonly idleSleepMs: number;
  private readonly customSleep?: (ms: number) => Promise<void>;

  private running = false;
  private loopPromise?: Promise<void>;
  private wake?: () => void;

  constructor(deps: WorkerDeps) {
    this.queue = deps.queue;
    this.engine = deps.engine;
    this.log = deps.logger ?? noopLogger;
    this.idleSleepMs = deps.idleSleepMs ?? DEFAULT_IDLE_SLEEP_MS;
    this.customSleep = deps.sleep;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.log.info('worker started');
    this.loopPromise = this.loop();
    await this.loopPromise;
  }

  async stop(): Promise<void> {
    this.running = false;
    // Interrupt an in-progress idle sleep so shutdown is prompt.
    this.wake?.();
    await this.loopPromise;
    this.log.info('worker stopped');
  }

  async runOnce(): Promise<'processed' | 'idle'> {
    const event = await this.queue.claimNext();
    if (!event) {
      return 'idle';
    }
    await this.process(event);
    return 'processed';
  }

  private async loop(): Promise<void> {
    // Drain while there's work; sleep briefly when the queue is empty.
    while (this.running) {
      const status = await this.runOnce();
      if (status === 'idle' && this.running) {
        await this.idle();
      }
    }
  }

  private async process(event: QueueEvent): Promise<void> {
    // The payload is the IngestedEvent the ingestion layer enqueued.
    const ingested = event.payload as IngestedEvent;
    try {
      const result = await this.engine.handle(ingested);
      // A returned SyncResult is a success (including business skips/dedups).
      await this.queue.markDone(event.id);
      this.log.info('event processed', {
        id: event.id,
        type: event.eventType,
        outcome: result.outcome,
      });
    } catch (err) {
      await this.fail(event, err);
    }
  }

  private async fail(event: QueueEvent, err: unknown): Promise<void> {
    const report = toFailureReport(err);
    try {
      const outcome = await this.queue.markFailed(event.id, report);
      this.log.warn('event failed', {
        id: event.id,
        type: event.eventType,
        kind: report.kind,
        action: outcome.action,
        attempts: outcome.attempts,
        message: report.message,
      });
    } catch (markErr) {
      // Even settling the failure failed (e.g. DB blip). Leave the row 'processing';
      // reclaimStale will recover it. Never let this escape and kill the loop.
      this.log.warn('markFailed failed; leaving for reclaim', {
        id: event.id,
        message: markErr instanceof Error ? markErr.message : String(markErr),
      });
    }
  }

  private idle(): Promise<void> {
    if (this.customSleep) {
      return this.customSleep(this.idleSleepMs);
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, this.idleSleepMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}
