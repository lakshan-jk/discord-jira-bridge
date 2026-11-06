import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJiraClient } from './client.js';
import { DISCORD_ISSUE_PROPERTY_KEY } from './types.js';
import { PermanentJiraError, TransientJiraError } from '../lib/errors.js';

const CONFIG = {
  baseUrl: 'https://example.atlassian.net',
  email: 'svc@example.com',
  apiToken: 'token-123',
};

/** Build a Response-like object for the mocked fetch. */
function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Grab the parsed body of the Nth fetch call. */
function callBody(mock: ReturnType<typeof vi.fn>, index = 0): any {
  const call = mock.mock.calls[index]!;
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createStory', () => {
  it('stamps the discord thread-ID property in the same create call (atomic)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: '1001', key: 'CHK-1' }));
    const client = createJiraClient(CONFIG);

    const ref = await client.createStory({
      projectKey: 'CHK',
      summary: 'Checkout is broken',
      description: 'line one\nline two',
      threadId: 'thread-abc',
    });

    // Exactly one HTTP call — not create-then-PUT.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.atlassian.net/rest/api/3/issue');
    expect(init.method).toBe('POST');

    const body = callBody(fetchMock);
    expect(body.properties).toEqual([
      { key: DISCORD_ISSUE_PROPERTY_KEY, value: { threadId: 'thread-abc' } },
    ]);
    expect(body.fields.issuetype).toEqual({ name: 'Story' });
    expect(body.fields.summary).toBe('Checkout is broken');
    // description is ADF, not a plain string.
    expect(body.fields.description.type).toBe('doc');

    expect(ref).toEqual({
      id: '1001',
      key: 'CHK-1',
      url: 'https://example.atlassian.net/browse/CHK-1',
    });
  });

  it('sends basic auth derived from email + token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: '1', key: 'CHK-1' }));
    const client = createJiraClient(CONFIG);
    await client.createStory({
      projectKey: 'CHK',
      summary: 's',
      description: 'd',
      threadId: 't',
    });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const expected = `Basic ${Buffer.from('svc@example.com:token-123').toString('base64')}`;
    expect((init.headers as Record<string, string>).Authorization).toBe(expected);
  });
});

describe('findStoryByThreadId', () => {
  it('returns an issue ref on a JQL property hit', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { issues: [{ id: '2002', key: 'CHK-9' }] }),
    );
    const client = createJiraClient(CONFIG);

    const ref = await client.findStoryByThreadId('CHK', 'thread-xyz');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.atlassian.net/rest/api/3/search/jql');
    expect(init.method).toBe('POST');
    // Server-side JQL on the property — not a client-side scan.
    const body = callBody(fetchMock);
    expect(body.jql).toContain(`issue.property["${DISCORD_ISSUE_PROPERTY_KEY}"].threadId`);
    expect(body.jql).toContain('thread-xyz');
    expect(body.jql).toContain('project = "CHK"');

    expect(ref).toEqual({
      id: '2002',
      key: 'CHK-9',
      url: 'https://example.atlassian.net/browse/CHK-9',
    });
  });

  it('returns null when no issue matches', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { issues: [] }));
    const client = createJiraClient(CONFIG);
    expect(await client.findStoryByThreadId('CHK', 'nope')).toBeNull();
  });
});

describe('getProject', () => {
  it('returns null only on 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { errorMessages: ['No project'] }));
    const client = createJiraClient(CONFIG);
    expect(await client.getProject('NOPE')).toBeNull();
  });

  it('rejects (not null) on auth failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { errorMessages: ['Unauthorized'] }));
    const client = createJiraClient(CONFIG);
    await expect(client.getProject('CHK')).rejects.toBeInstanceOf(PermanentJiraError);
  });

  it('rejects on 5xx', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { errorMessages: ['down'] }));
    const client = createJiraClient(CONFIG);
    await expect(client.getProject('CHK')).rejects.toBeInstanceOf(TransientJiraError);
  });
});

describe('transitionIssue', () => {
  it('resolves the transition ID by status name (case-insensitive) and applies it', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          transitions: [
            { id: '11', name: 'Start', to: { name: 'In Progress' } },
            { id: '21', name: 'Done', to: { name: 'Done' } },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const client = createJiraClient(CONFIG);
    const outcome = await client.transitionIssue('CHK-1', 'in progress');

    expect(outcome).toEqual({ status: 'applied', transitionId: '11', toStatusName: 'In Progress' });
    // Second call posts the resolved transition id.
    expect(callBody(fetchMock, 1)).toEqual({ transition: { id: '11' } });
  });

  it('returns an unavailable outcome (no throw) carrying what was offered', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        transitions: [{ id: '21', name: 'Done', to: { name: 'Done' } }],
      }),
    );

    const client = createJiraClient(CONFIG);
    const outcome = await client.transitionIssue('CHK-1', 'In Review');

    expect(outcome.status).toBe('unavailable');
    if (outcome.status === 'unavailable') {
      expect(outcome.requested).toBe('In Review');
      expect(outcome.available.map((t) => t.toStatusName)).toEqual(['Done']);
    }
    // Only the list call happened — no transition POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('error classification boundaries', () => {
  it('classifies 429 as transient and parses Retry-After into retryAfterMs', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, { errorMessages: ['rate limited'] }, { 'retry-after': '7' }),
    );
    const client = createJiraClient(CONFIG);

    await expect(client.getProject('CHK')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TransientJiraError);
      const e = err as TransientJiraError;
      expect(e.isRetryable).toBe(true);
      expect(e.retryAfterMs).toBe(7000);
      return true;
    });
  });

  it('classifies 400 as permanent (not retryable)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { errorMessages: ['bad'] }));
    const client = createJiraClient(CONFIG);
    await expect(client.getProject('CHK')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(PermanentJiraError);
      expect((err as PermanentJiraError).isRetryable).toBe(false);
      return true;
    });
  });

  it('wraps a network/timeout throw as transient', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const client = createJiraClient(CONFIG);
    await expect(client.getProject('CHK')).rejects.toBeInstanceOf(TransientJiraError);
  });
});
