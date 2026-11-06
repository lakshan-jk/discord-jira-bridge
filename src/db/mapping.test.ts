import { describe, expect, it } from 'vitest';
import { InMemoryMappingStore } from './memory.js';
import { DuplicateMappingError } from './types.js';

describe('mapping store (primary dedup)', () => {
  it('stores and finds a mapping by thread id', async () => {
    const store = new InMemoryMappingStore();
    await store.insert({ discordThreadId: 't1', jiraIssueKey: 'CHK-1', jiraIssueId: '1001' });

    const found = await store.findByThreadId('t1');
    expect(found?.jiraIssueKey).toBe('CHK-1');
    expect(await store.findByThreadId('missing')).toBeNull();
  });

  it('fails loudly on a duplicate insert rather than creating a second mapping', async () => {
    const store = new InMemoryMappingStore();
    await store.insert({ discordThreadId: 't1', jiraIssueKey: 'CHK-1', jiraIssueId: '1001' });

    await expect(
      store.insert({ discordThreadId: 't1', jiraIssueKey: 'CHK-2', jiraIssueId: '1002' }),
    ).rejects.toBeInstanceOf(DuplicateMappingError);

    // The original mapping is untouched — no overwrite.
    expect((await store.findByThreadId('t1'))?.jiraIssueKey).toBe('CHK-1');
  });
});
