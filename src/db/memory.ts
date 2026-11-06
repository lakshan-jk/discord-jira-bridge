/**
 * In-memory reference implementations of EventQueue and MappingStore.
 *
 * Two purposes: (1) the fakes the sync engine is unit-tested against, and (2) the
 * executable specification of the queue contract — per-project ordering, one in
 * flight per project, retry/dead-letter. They call the SAME retry-policy functions
 * as the pg implementation, so failure semantics are identical.
 *
 * NOTE: these do not model true cross-process locking (SKIP LOCKED / the partial
 * unique index) — that concurrency primitive is a Postgres behaviour exercised by
 * integration tests against a real database. What they faithfully model is the
 * single-worker contract the sync engine depends on.
 */

import { backoffDelayMs, decideFailure } from './retry-policy.js';
import {
  DuplicateMappingError,
  type DiscordJiraMapping,
  type EnqueueInput,
  type EventQueue,
  type EventStatus,
  type FailureOutcome,
  type FailureReport,
  type InsertMappingInput,
  type MappingStore,
  type QueueEvent,
} from './types.js';

type Clock = () => number;

interface MutableEvent {
  id: string;
  projectKey: string;
  eventType: string;
  discordThreadId: string;
  payload: unknown;
  status: EventStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  availableAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

function snapshot(e: MutableEvent): QueueEvent {
  return { ...e };
}

export class InMemoryEventQueue implements EventQueue {
  private readonly events: MutableEvent[] = [];
  private seq = 0;

  constructor(private readonly now: Clock = () => Date.now()) {}

  enqueue(input: EnqueueInput): Promise<QueueEvent> {
    const ts = new Date(this.now());
    const event: MutableEvent = {
      id: String(++this.seq),
      projectKey: input.projectKey,
      eventType: input.eventType,
      discordThreadId: input.discordThreadId,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 5,
      lastError: null,
      availableAt: ts,
      createdAt: ts,
      updatedAt: ts,
    };
    this.events.push(event);
    return Promise.resolve(snapshot(event));
  }

  claimNext(): Promise<QueueEvent | null> {
    const nowMs = this.now();
    const busyProjects = new Set(
      this.events.filter((e) => e.status === 'processing').map((e) => e.projectKey),
    );

    // Earliest pending (FIFO by id) whose project has nothing in flight and whose
    // backoff has elapsed.
    const candidate = this.events
      .filter(
        (e) =>
          e.status === 'pending' &&
          e.availableAt.getTime() <= nowMs &&
          !busyProjects.has(e.projectKey),
      )
      .sort((a, b) => Number(a.id) - Number(b.id))[0];

    if (!candidate) {
      return Promise.resolve(null);
    }

    candidate.status = 'processing';
    candidate.attempts += 1;
    candidate.updatedAt = new Date(nowMs);
    return Promise.resolve(snapshot(candidate));
  }

  markDone(id: string): Promise<void> {
    const event = this.require(id);
    event.status = 'done';
    event.updatedAt = new Date(this.now());
    return Promise.resolve();
  }

  markFailed(id: string, failure: FailureReport): Promise<FailureOutcome> {
    const event = this.require(id);
    event.lastError = failure.message;
    event.updatedAt = new Date(this.now());

    const decision = decideFailure({
      attempts: event.attempts,
      maxAttempts: event.maxAttempts,
      kind: failure.kind,
    });

    if (decision === 'dead-letter') {
      event.status = 'failed';
      return Promise.resolve({ action: 'dead-letter', attempts: event.attempts });
    }

    const delayMs = backoffDelayMs(event.attempts, failure.retryAfterMs);
    event.status = 'pending';
    event.availableAt = new Date(this.now() + delayMs);
    return Promise.resolve({
      action: 'retry',
      availableAt: event.availableAt,
      attempts: event.attempts,
    });
  }

  reclaimStale(olderThanMs: number): Promise<number> {
    const cutoff = this.now() - olderThanMs;
    let reclaimed = 0;
    for (const event of this.events) {
      if (event.status === 'processing' && event.updatedAt.getTime() < cutoff) {
        if (event.attempts >= event.maxAttempts) {
          event.status = 'failed';
          event.lastError = 'dead-lettered after stale processing (worker crash?)';
        } else {
          event.status = 'pending';
        }
        event.updatedAt = new Date(this.now());
        reclaimed += 1;
      }
    }
    return Promise.resolve(reclaimed);
  }

  /** Test helper: read current state of an event. */
  peek(id: string): QueueEvent | undefined {
    const event = this.events.find((e) => e.id === id);
    return event ? snapshot(event) : undefined;
  }

  private require(id: string): MutableEvent {
    const event = this.events.find((e) => e.id === id);
    if (!event) {
      throw new Error(`event ${id} not found`);
    }
    return event;
  }
}

export class InMemoryMappingStore implements MappingStore {
  private readonly byThread = new Map<string, DiscordJiraMapping>();

  constructor(private readonly now: Clock = () => Date.now()) {}

  insert(input: InsertMappingInput): Promise<DiscordJiraMapping> {
    if (this.byThread.has(input.discordThreadId)) {
      // Mirror the unique-constraint behaviour: fail loudly, never overwrite.
      return Promise.reject(new DuplicateMappingError(input.discordThreadId));
    }
    const mapping: DiscordJiraMapping = {
      discordThreadId: input.discordThreadId,
      jiraIssueKey: input.jiraIssueKey,
      jiraIssueId: input.jiraIssueId,
      createdAt: new Date(this.now()),
    };
    this.byThread.set(input.discordThreadId, mapping);
    return Promise.resolve(mapping);
  }

  findByThreadId(discordThreadId: string): Promise<DiscordJiraMapping | null> {
    return Promise.resolve(this.byThread.get(discordThreadId) ?? null);
  }
}
