/**
 * PostgreSQL persistence layer — public surface.
 *
 * Owns the durable event queue (the at-least-once inbox) and the
 * discord-id <-> jira-id mapping, whose unique constraint is the primary,
 * strongly-consistent dedup (design decision #4). The sync engine depends on the
 * EventQueue / MappingStore interfaces, not these concrete pg implementations, so
 * it can be unit-tested against the in-memory fakes.
 */

export type { Db, DbConfig } from './client.js';
export { createDb, migrate } from './client.js';

export { createEventQueue } from './queue.js';
export { createMappingStore } from './mapping.js';
export { InMemoryEventQueue, InMemoryMappingStore } from './memory.js';
export { decideFailure, backoffDelayMs } from './retry-policy.js';
export { SCHEMA_SQL } from './schema.js';

export type {
  EventStatus,
  QueueEvent,
  EnqueueInput,
  FailureReport,
  FailureOutcome,
  EventQueue,
  DiscordJiraMapping,
  InsertMappingInput,
  MappingStore,
} from './types.js';
export { DuplicateMappingError } from './types.js';
