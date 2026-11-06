/**
 * Sync engine — the domain core. Public surface.
 *
 * Orchestrates each inbound event into JIRA operations, enforcing the idempotency
 * ordering (DB mapping -> findStoryByThreadId -> createStory) and the
 * transition/blocked handling from the design doc. Depends on the JiraClient and
 * MappingStore interfaces, never on Discord or a live connection.
 */

export { createSyncEngine } from './engine.js';
export type { SyncEngine, SyncDeps, SyncResult, SyncLogger } from './types.js';
