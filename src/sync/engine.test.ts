import { describe, expect, it, vi } from 'vitest';
import { createSyncEngine } from './engine.js';
import { InMemoryMappingStore } from '../db/memory.js';
import type { JiraClient, JiraIssueRef, JiraProject, TransitionOutcome } from '../jira/index.js';
import type {
  CommentEvent,
  StatusCommandEvent,
  ThreadCreatedEvent,
} from '../discord/index.js';

const AT = new Date('2026-11-06T10:00:00Z');

/** A fully mocked JiraClient; override per test. */
function mockJira(over: Partial<JiraClient> = {}): JiraClient {
  const project: JiraProject = { id: '1', key: 'CHK', name: 'Checkout' };
  const ref: JiraIssueRef = { id: '1001', key: 'CHK-1', url: 'https://x/browse/CHK-1' };
  return {
    getProject: vi.fn<JiraClient['getProject']>().mockResolvedValue(project),
    findStoryByThreadId: vi.fn<JiraClient['findStoryByThreadId']>().mockResolvedValue(null),
    createStory: vi.fn<JiraClient['createStory']>().mockResolvedValue(ref),
    addComment: vi.fn<JiraClient['addComment']>().mockResolvedValue(undefined),
    addLabels: vi.fn<JiraClient['addLabels']>().mockResolvedValue(undefined),
    listTransitions: vi.fn<JiraClient['listTransitions']>().mockResolvedValue([]),
    transitionIssue: vi.fn<JiraClient['transitionIssue']>(),
    ...over,
  };
}

function threadEvent(over: Partial<ThreadCreatedEvent> = {}): ThreadCreatedEvent {
  return {
    type: 'thread_created',
    projectKey: 'CHK',
    threadId: 'thread-1',
    authorDisplayName: 'Ada',
    occurredAt: AT,
    source: 'gateway',
    title: 'Checkout broken',
    body: 'does nothing',
    ...over,
  };
}

function statusEvent(over: Partial<StatusCommandEvent> = {}): StatusCommandEvent {
  return {
    type: 'status_command',
    projectKey: 'CHK',
    threadId: 'thread-1',
    authorDisplayName: 'Ada',
    occurredAt: AT,
    source: 'gateway',
    messageId: 'm1',
    targetStatus: 'In Progress',
    rawBody: '/status In Progress',
    ...over,
  };
}

function commentEvent(over: Partial<CommentEvent> = {}): CommentEvent {
  return {
    type: 'comment',
    projectKey: 'CHK',
    threadId: 'thread-1',
    authorDisplayName: 'Ada',
    occurredAt: AT,
    source: 'gateway',
    messageId: 'm1',
    body: 'an update',
    ...over,
  };
}

describe('create path — duplicate-prevention ordering', () => {
  it('creates only when BOTH the DB mapping and JIRA are empty, then saves the mapping', async () => {
    const jira = mockJira();
    const mappings = new InMemoryMappingStore();
    const findSpy = vi.spyOn(mappings, 'findByThreadId');
    const insertSpy = vi.spyOn(mappings, 'insert');
    const engine = createSyncEngine({ jira, mappings });

    const result = await engine.handle(threadEvent());

    expect(result).toEqual({ outcome: 'created', issueKey: 'CHK-1' });
    expect(jira.createStory).toHaveBeenCalledOnce();
    // Ordering: project -> DB mapping -> JIRA find -> createStory -> save mapping.
    const order = [
      (jira.getProject as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
      findSpy.mock.invocationCallOrder[0]!,
      (jira.findStoryByThreadId as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
      (jira.createStory as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
      insertSpy.mock.invocationCallOrder[0]!,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The thread id was stamped for idempotency.
    expect(jira.createStory).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    expect(await mappings.findByThreadId('thread-1')).not.toBeNull();
  });

  it('short-circuits on a DB mapping hit — never touches JIRA find or create', async () => {
    const jira = mockJira();
    const mappings = new InMemoryMappingStore();
    await mappings.insert({ discordThreadId: 'thread-1', jiraIssueKey: 'CHK-9', jiraIssueId: '9' });
    const engine = createSyncEngine({ jira, mappings });

    const result = await engine.handle(threadEvent());

    expect(result).toEqual({ outcome: 'deduped', issueKey: 'CHK-9' });
    expect(jira.findStoryByThreadId).not.toHaveBeenCalled();
    expect(jira.createStory).not.toHaveBeenCalled();
  });

  it('recovers from JIRA when the DB mapping is missing — dedups and persists, no create', async () => {
    const jira = mockJira({
      findStoryByThreadId: vi
        .fn<JiraClient['findStoryByThreadId']>()
        .mockResolvedValue({ id: '77', key: 'CHK-7', url: 'https://x/browse/CHK-7' }),
    });
    const mappings = new InMemoryMappingStore();
    const engine = createSyncEngine({ jira, mappings });

    const result = await engine.handle(threadEvent());

    expect(result).toEqual({ outcome: 'deduped', issueKey: 'CHK-7' });
    expect(jira.createStory).not.toHaveBeenCalled();
    // Recovered mapping is now persisted for next time.
    expect((await mappings.findByThreadId('thread-1'))?.jiraIssueKey).toBe('CHK-7');
  });
});

describe('missing project — log and skip', () => {
  it('skips and never creates when the project does not exist', async () => {
    const warn = vi.fn();
    const jira = mockJira({
      getProject: vi.fn<JiraClient['getProject']>().mockResolvedValue(null),
    });
    const mappings = new InMemoryMappingStore();
    const engine = createSyncEngine({ jira, mappings, logger: { info: vi.fn(), warn } });

    const result = await engine.handle(threadEvent());

    expect(result).toEqual({ outcome: 'skipped', reason: 'project_not_found' });
    expect(jira.createStory).not.toHaveBeenCalled();
    expect(jira.findStoryByThreadId).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe('status command — comment always recorded', () => {
  it('records the comment even when the transition comes back unavailable', async () => {
    const jira = mockJira({
      transitionIssue: vi.fn<JiraClient['transitionIssue']>().mockResolvedValue({
        status: 'unavailable',
        requested: 'In Progress',
        available: [{ id: '21', name: 'Done', toStatusName: 'Done' }],
      } satisfies TransitionOutcome),
    });
    const mappings = new InMemoryMappingStore();
    await mappings.insert({ discordThreadId: 'thread-1', jiraIssueKey: 'CHK-1', jiraIssueId: '1' });
    const engine = createSyncEngine({ jira, mappings });

    const result = await engine.handle(statusEvent());

    expect(result).toEqual({ outcome: 'transition_skipped', issueKey: 'CHK-1', requested: 'In Progress' });
    // The comment was recorded despite the skipped transition.
    expect(jira.addComment).toHaveBeenCalledWith('CHK-1', {
      authorDisplayName: 'Ada',
      body: '/status In Progress',
    });
  });

  it('applies an available transition and records the comment', async () => {
    const jira = mockJira({
      transitionIssue: vi.fn<JiraClient['transitionIssue']>().mockResolvedValue({
        status: 'applied',
        transitionId: '11',
        toStatusName: 'In Progress',
      }),
    });
    const mappings = new InMemoryMappingStore();
    await mappings.insert({ discordThreadId: 'thread-1', jiraIssueKey: 'CHK-1', jiraIssueId: '1' });
    const engine = createSyncEngine({ jira, mappings });

    const result = await engine.handle(statusEvent());

    expect(result).toEqual({ outcome: 'transitioned', issueKey: 'CHK-1', toStatus: 'In Progress' });
    expect(jira.addComment).toHaveBeenCalledOnce();
  });

  it('handles /blocked as a label + comment, not a transition', async () => {
    const jira = mockJira();
    const mappings = new InMemoryMappingStore();
    await mappings.insert({ discordThreadId: 'thread-1', jiraIssueKey: 'CHK-1', jiraIssueId: '1' });
    const engine = createSyncEngine({ jira, mappings });

    const result = await engine.handle(statusEvent({ targetStatus: 'blocked', rawBody: '/blocked' }));

    expect(result).toEqual({ outcome: 'blocked', issueKey: 'CHK-1' });
    expect(jira.addLabels).toHaveBeenCalledWith('CHK-1', ['blocked']);
    expect(jira.transitionIssue).not.toHaveBeenCalled();
    expect(jira.addComment).toHaveBeenCalledOnce();
  });
});

describe('comment path — story resolution', () => {
  it('recovers a missing mapping via JIRA before giving up', async () => {
    const jira = mockJira({
      findStoryByThreadId: vi
        .fn<JiraClient['findStoryByThreadId']>()
        .mockResolvedValue({ id: '5', key: 'CHK-5', url: 'https://x/browse/CHK-5' }),
    });
    const mappings = new InMemoryMappingStore();
    const engine = createSyncEngine({ jira, mappings });

    const result = await engine.handle(commentEvent());

    expect(result).toEqual({ outcome: 'commented', issueKey: 'CHK-5' });
    expect(jira.addComment).toHaveBeenCalledWith('CHK-5', { authorDisplayName: 'Ada', body: 'an update' });
  });

  it('skips when no Story can be found anywhere', async () => {
    const jira = mockJira();
    const mappings = new InMemoryMappingStore();
    const engine = createSyncEngine({ jira, mappings });

    const result = await engine.handle(commentEvent());

    expect(result).toEqual({ outcome: 'skipped', reason: 'story_not_found' });
    expect(jira.addComment).not.toHaveBeenCalled();
  });
});
