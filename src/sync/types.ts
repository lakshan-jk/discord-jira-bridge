/**
 * Types for the sync engine — the domain core.
 *
 * The engine consumes ONE normalized IngestedEvent and performs the corresponding
 * JIRA work. It depends only on the JiraClient and MappingStore interfaces (both
 * injected), never on Discord, the queue, or a live connection — so it is pure and
 * fully unit-testable against mocks.
 */

import type { JiraClient } from '../jira/index.js';
import type { MappingStore } from '../db/index.js';
import type { IngestedEvent } from '../discord/index.js';

export interface SyncLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * The result of handling one event, expressed as data so tests assert on outcomes
 * rather than on mock call shapes. Expected business outcomes are returned here;
 * infra failures (JiraError on 5xx/network) are thrown instead, so the queue's
 * retry/backoff layer can classify and retry them.
 */
export type SyncResult =
  | { readonly outcome: 'created'; readonly issueKey: string }
  | { readonly outcome: 'deduped'; readonly issueKey: string }
  | { readonly outcome: 'commented'; readonly issueKey: string }
  | { readonly outcome: 'transitioned'; readonly issueKey: string; readonly toStatus: string }
  | { readonly outcome: 'transition_skipped'; readonly issueKey: string; readonly requested: string }
  | { readonly outcome: 'blocked'; readonly issueKey: string }
  | { readonly outcome: 'skipped'; readonly reason: 'project_not_found' | 'story_not_found' };

export interface SyncDeps {
  readonly jira: JiraClient;
  readonly mappings: MappingStore;
  readonly logger?: SyncLogger;
}

export interface SyncEngine {
  handle(event: IngestedEvent): Promise<SyncResult>;
}
