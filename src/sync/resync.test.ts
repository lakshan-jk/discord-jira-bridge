import { describe, expect, it, vi } from 'vitest';
import { createResyncer } from './resync.js';
import { createSyncEngine } from './engine.js';
import { InMemoryMappingStore } from '../db/memory.js';
import type { ResyncGateway } from './resync.js';
import type { BackfillQuery, RawThread } from '../discord/index.js';
import type { JiraClient, JiraIssueRef, JiraProject } from '../jira/index.js';

/** A fake gateway exposing fixed threads and capturing replies. */
class FakeGateway implements ResyncGateway {
  sent: { channelId: string; content: string }[] = [];
  constructor(private readonly threads: RawThread[]) {}
  listThreads(query: BackfillQuery): Promise<readonly RawThread[]> {
    const visible = query.includeArchived ? this.threads : this.threads.filter((t) => !t.archived);
    return Promise.resolve(visible);
  }
  sendMessage(channelId: string, content: string): Promise<void> {
    this.sent.push({ channelId, content });
    return Promise.resolve();
  }
}

function thread(id: string, channel: string, over: Partial<RawThread> = {}): RawThread {
  return {
    id,
    name: `Post ${id}`,
    parentChannelName: channel,
    createdAt: new Date('2026-11-06T10:00:00Z'),
    archived: false,
    ownerDisplayName: 'Ada',
    starterMessageContent: 'body',
    ...over,
  };
}

/** Mock JiraClient; createStory returns a ref derived from the summary order. */
function mockJira(over: Partial<JiraClient> = {}): JiraClient {
  const project: JiraProject = { id: '1', key: 'CHECKOUT', name: 'Checkout' };
  let seq = 0;
  return {
    getProject: vi.fn<JiraClient['getProject']>().mockResolvedValue(project),
    findStoryByThreadId: vi.fn<JiraClient['findStoryByThreadId']>().mockResolvedValue(null),
    createStory: vi.fn<JiraClient['createStory']>().mockImplementation(() => {
      seq += 1;
      const ref: JiraIssueRef = { id: `10${seq}`, key: `CHECKOUT-${seq}`, url: `https://x/CHECKOUT-${seq}` };
      return Promise.resolve(ref);
    }),
    addComment: vi.fn<JiraClient['addComment']>().mockResolvedValue(undefined),
    addLabels: vi.fn<JiraClient['addLabels']>().mockResolvedValue(undefined),
    listTransitions: vi.fn<JiraClient['listTransitions']>().mockResolvedValue([]),
    transitionIssue: vi.fn<JiraClient['transitionIssue']>(),
    ...over,
  };
}

function build(threads: RawThread[], jira: JiraClient, mappings = new InMemoryMappingStore()) {
  const gateway = new FakeGateway(threads);
  const engine = createSyncEngine({ jira, mappings });
  const resyncer = createResyncer({ gateway, engine });
  return { gateway, resyncer, mappings };
}

describe('resync', () => {
  it('creates missing Stories, dedups existing ones, and replies with a summary', async () => {
    const jira = mockJira();
    const mappings = new InMemoryMappingStore();
    // t2 already has a mapping -> should be counted already-synced, not re-created.
    await mappings.insert({ discordThreadId: 't2', jiraIssueKey: 'CHECKOUT-99', jiraIssueId: '99' });

    const threads = [
      thread('t1', 'proj-checkout'),
      thread('t2', 'proj-checkout'),
      thread('t3', 'proj-checkout'),
    ];
    const { gateway, resyncer } = build(threads, jira, mappings);

    const summary = await resyncer.resync({ channelName: 'proj-checkout', replyChannelId: 'reply-1' });

    expect(summary).toMatchObject({
      projectKey: 'CHECKOUT',
      checked: 3,
      created: 2,
      alreadySynced: 1,
      skipped: 0,
    });
    // Only the two unmapped threads were created; the existing one was never touched.
    expect(jira.createStory).toHaveBeenCalledTimes(2);

    // Replied into the originating channel with the counts.
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]!.channelId).toBe('reply-1');
    expect(gateway.sent[0]!.content).toContain('created 2');
    expect(gateway.sent[0]!.content).toContain('already synced 1');
  });

  it('only touches threads in the target channel', async () => {
    const jira = mockJira();
    const threads = [
      thread('t1', 'proj-checkout'),
      thread('x1', 'proj-payments'), // different channel — must be ignored
    ];
    const { resyncer } = build(threads, jira);

    const summary = await resyncer.resync({ channelName: 'proj-checkout', replyChannelId: 'r' });

    expect(summary.checked).toBe(1);
    expect(jira.createStory).toHaveBeenCalledTimes(1);
    expect(jira.createStory).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't1' }));
  });

  it('counts a JIRA-marker recovery (DB empty, marker present) as already-synced, no create', async () => {
    const jira = mockJira({
      findStoryByThreadId: vi
        .fn<JiraClient['findStoryByThreadId']>()
        .mockResolvedValue({ id: '7', key: 'CHECKOUT-7', url: 'https://x/CHECKOUT-7' }),
    });
    const { resyncer } = build([thread('t1', 'proj-checkout')], jira);

    const summary = await resyncer.resync({ channelName: 'proj-checkout', replyChannelId: 'r' });

    expect(summary).toMatchObject({ checked: 1, created: 0, alreadySynced: 1 });
    expect(jira.createStory).not.toHaveBeenCalled();
  });

  it('counts threads as skipped when the project does not exist', async () => {
    const jira = mockJira({
      getProject: vi.fn<JiraClient['getProject']>().mockResolvedValue(null),
    });
    const { gateway, resyncer } = build([thread('t1', 'proj-checkout')], jira);

    const summary = await resyncer.resync({ channelName: 'proj-checkout', replyChannelId: 'r' });

    expect(summary).toMatchObject({ checked: 1, created: 0, alreadySynced: 0, skipped: 1 });
    expect(jira.createStory).not.toHaveBeenCalled();
    expect(gateway.sent[0]!.content).toContain('skipped 1');
  });

  it('replies with a friendly message when the channel has no threads', async () => {
    const jira = mockJira();
    const { gateway, resyncer } = build([], jira);

    const summary = await resyncer.resync({ channelName: 'proj-empty', replyChannelId: 'r' });

    expect(summary.checked).toBe(0);
    expect(gateway.sent[0]!.content).toContain('no threads found');
  });
});
