/**
 * Sync engine implementation.
 *
 * One event in, one JIRA effect out. Pure w.r.t. Discord and the queue: it only
 * touches the injected JiraClient and MappingStore. The 'blocked' status is handled
 * as a label + comment (design #5), never as an assumed workflow status.
 */

import { DuplicateMappingError, type MappingStore } from '../db/index.js';
import type { CommentEvent, IngestedEvent, StatusCommandEvent, ThreadCreatedEvent } from '../discord/index.js';
import type { JiraClient } from '../jira/index.js';
import type { SyncDeps, SyncEngine, SyncLogger, SyncResult } from './types.js';

const BLOCKED = 'blocked';

const noopLogger: SyncLogger = {
  info: () => {},
  warn: () => {},
};

export function createSyncEngine(deps: SyncDeps): SyncEngine {
  return new SyncEngineImpl(deps.jira, deps.mappings, deps.logger ?? noopLogger);
}

class SyncEngineImpl implements SyncEngine {
  constructor(
    private readonly jira: JiraClient,
    private readonly mappings: MappingStore,
    private readonly log: SyncLogger,
  ) {}

  handle(event: IngestedEvent): Promise<SyncResult> {
    switch (event.type) {
      case 'thread_created':
        return this.handleThreadCreated(event);
      case 'comment':
        return this.handleComment(event);
      case 'status_command':
        return this.handleStatusCommand(event);
    }
  }

  /**
   * Create path, in exactly this order (design #4):
   *   1. project lookup — if it doesn't exist, log and skip (never create it, design #3)
   *   2. local DB mapping — if present, it already exists: dedup
   *   3. JIRA findStoryByThreadId — backup check that survives local state loss
   *   4. only if BOTH are empty, createStory (which stamps the thread-ID marker)
   *   5. save the mapping
   */
  private async handleThreadCreated(event: ThreadCreatedEvent): Promise<SyncResult> {
    const project = await this.jira.getProject(event.projectKey);
    if (project === null) {
      this.log.warn('project not found — skipping', {
        projectKey: event.projectKey,
        threadId: event.threadId,
      });
      return { outcome: 'skipped', reason: 'project_not_found' };
    }

    const existing = await this.mappings.findByThreadId(event.threadId);
    if (existing) {
      return { outcome: 'deduped', issueKey: existing.jiraIssueKey };
    }

    const remote = await this.jira.findStoryByThreadId(event.projectKey, event.threadId);
    if (remote) {
      // Recovered a Story created by a prior run that crashed before saving the
      // mapping. Persist the mapping so future lookups hit the DB, then dedup.
      await this.saveMapping(event.threadId, remote.key, remote.id);
      return { outcome: 'deduped', issueKey: remote.key };
    }

    const created = await this.jira.createStory({
      projectKey: event.projectKey,
      summary: event.title,
      description: event.body,
      threadId: event.threadId,
    });
    await this.saveMapping(event.threadId, created.key, created.id);
    return { outcome: 'created', issueKey: created.key };
  }

  private async handleComment(event: CommentEvent): Promise<SyncResult> {
    const issueKey = await this.resolveStory(event);
    if (issueKey === null) {
      return { outcome: 'skipped', reason: 'story_not_found' };
    }
    await this.jira.addComment(issueKey, {
      authorDisplayName: event.authorDisplayName,
      body: event.body,
    });
    return { outcome: 'commented', issueKey };
  }

  private async handleStatusCommand(event: StatusCommandEvent): Promise<SyncResult> {
    const issueKey = await this.resolveStory(event);
    if (issueKey === null) {
      return { outcome: 'skipped', reason: 'story_not_found' };
    }

    // Always record the comment first, regardless of what happens with the status.
    await this.jira.addComment(issueKey, {
      authorDisplayName: event.authorDisplayName,
      body: event.rawBody,
    });

    // 'blocked' is a label + comment, not a transition (design #5).
    if (event.targetStatus.toLowerCase() === BLOCKED) {
      await this.jira.addLabels(issueKey, [BLOCKED]);
      return { outcome: 'blocked', issueKey };
    }

    const outcome = await this.jira.transitionIssue(issueKey, event.targetStatus);
    if (outcome.status === 'applied') {
      return { outcome: 'transitioned', issueKey, toStatus: outcome.toStatusName };
    }

    // Transition not offered by this workflow — comment is already recorded; log the skip.
    this.log.info('transition unavailable — comment recorded, transition skipped', {
      issueKey,
      requested: event.targetStatus,
      available: outcome.available.map((t) => t.toStatusName),
    });
    return { outcome: 'transition_skipped', issueKey, requested: event.targetStatus };
  }

  /**
   * Resolve the Story for a comment/status event: DB mapping first, then recover via
   * JIRA's thread-ID marker before giving up (and persist the recovered mapping).
   */
  private async resolveStory(event: CommentEvent | StatusCommandEvent): Promise<string | null> {
    const mapped = await this.mappings.findByThreadId(event.threadId);
    if (mapped) {
      return mapped.jiraIssueKey;
    }

    const remote = await this.jira.findStoryByThreadId(event.projectKey, event.threadId);
    if (remote) {
      await this.saveMapping(event.threadId, remote.key, remote.id);
      return remote.key;
    }

    this.log.warn('no Story for event — skipping', {
      threadId: event.threadId,
      projectKey: event.projectKey,
    });
    return null;
  }

  /** Persist a mapping, tolerating a concurrent insert of the same thread. */
  private async saveMapping(threadId: string, issueKey: string, issueId: string): Promise<void> {
    try {
      await this.mappings.insert({
        discordThreadId: threadId,
        jiraIssueKey: issueKey,
        jiraIssueId: issueId,
      });
    } catch (err) {
      if (err instanceof DuplicateMappingError) {
        // Another delivery of the same event already saved it — benign.
        return;
      }
      throw err;
    }
  }
}
