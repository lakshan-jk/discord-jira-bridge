/**
 * JIRA Cloud REST v3 client.
 *
 * This is the only place that speaks HTTP and ADF. The public `JiraClient`
 * interface it satisfies is plain-text-in / plain-domain-out, so the sync engine
 * depends on the interface and can be unit-tested against a fake — the REST and ADF
 * detail never leaks past this boundary.
 */

import {
  asTransientNetworkError,
  classifyResponseError,
  PermanentJiraError,
} from '../lib/errors.js';
import { commentToAdf, textToAdf } from './adf.js';
import type { JiraClient, JiraClientConfig } from './index.js';
import {
  DISCORD_ISSUE_PROPERTY_KEY,
  type CommentInput,
  type CreateStoryInput,
  type JiraIssueRef,
  type JiraProject,
  type JiraTransition,
  type TransitionOutcome,
} from './types.js';

/** Shape of the property value we stamp onto the issue for idempotency. */
interface DiscordMarker {
  readonly threadId: string;
}

/* ----------------------------- REST response shapes ----------------------------- */
/* These describe only what we read from JIRA; they stay private to the client. */

interface RawProject {
  id: string;
  key: string;
  name: string;
}

interface RawIssueCreated {
  id: string;
  key: string;
}

interface RawIssueSearchResult {
  issues?: { id: string; key: string }[];
}

interface RawTransitionsResponse {
  transitions?: {
    id: string;
    name: string;
    to?: { name?: string };
  }[];
}

export function createJiraClient(config: JiraClientConfig): JiraClient {
  return new JiraHttpClient(config);
}

class JiraHttpClient implements JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(config: JiraClientConfig) {
    // Trim a trailing slash so path joins are predictable.
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    const token = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
    this.authHeader = `Basic ${token}`;
  }

  async getProject(key: string): Promise<JiraProject | null> {
    const res = await this.request('GET', `/rest/api/3/project/${encodeURIComponent(key)}`, {
      // 404 is an expected "no such project" answer (design #3), not an error.
      allowNotFound: true,
    });
    if (res === null) {
      return null;
    }
    const raw = res as RawProject;
    return { id: raw.id, key: raw.key, name: raw.name };
  }

  async findStoryByThreadId(projectKey: string, threadId: string): Promise<JiraIssueRef | null> {
    // Genuine server-side lookup: JQL filters on the issue property we stamp at
    // create time. No client-side scanning of issues/labels.
    const jql =
      `project = "${projectKey}" AND ` +
      `issue.property["${DISCORD_ISSUE_PROPERTY_KEY}"].threadId = "${threadId}"`;

    const res = (await this.request('POST', '/rest/api/3/search/jql', {
      body: { jql, maxResults: 1, fields: ['id', 'key'] },
    })) as RawIssueSearchResult;

    const hit = res.issues?.[0];
    return hit ? this.toIssueRef(hit.id, hit.key) : null;
  }

  async createStory(input: CreateStoryInput): Promise<JiraIssueRef> {
    const marker: DiscordMarker = { threadId: input.threadId };

    // Atomic create: the thread-ID property is set *in the same call* that creates
    // the issue (design #4). A create-then-PUT would reopen the crash window
    // between "issue created" and "marker written" — the exact gap the marker
    // exists to close — so we use the issue-create `properties` field instead.
    const body = {
      fields: {
        project: { key: input.projectKey },
        issuetype: { name: 'Story' },
        summary: input.summary,
        description: textToAdf(input.description),
        ...(input.reporterAccountId ? { reporter: { id: input.reporterAccountId } } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: [...input.labels] } : {}),
      },
      properties: [{ key: DISCORD_ISSUE_PROPERTY_KEY, value: marker }],
    };

    const res = (await this.request('POST', '/rest/api/3/issue', { body })) as RawIssueCreated;
    return this.toIssueRef(res.id, res.key);
  }

  async addComment(issueKey: string, comment: CommentInput): Promise<void> {
    await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      body: { body: commentToAdf(comment) },
    });
  }

  async addLabels(issueKey: string, labels: readonly string[]): Promise<void> {
    if (labels.length === 0) {
      return;
    }
    // The issue-edit endpoint's `update` verb appends labels without clobbering any
    // the issue already has.
    await this.request('PUT', `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      body: { update: { labels: labels.map((name) => ({ add: name })) } },
    });
  }

  async listTransitions(issueKey: string): Promise<readonly JiraTransition[]> {
    const res = (await this.request(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    )) as RawTransitionsResponse;

    return (res.transitions ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      toStatusName: t.to?.name ?? t.name,
    }));
  }

  async transitionIssue(issueKey: string, targetStatusName: string): Promise<TransitionOutcome> {
    // Transition IDs are workflow-specific, so resolve at runtime (design #5).
    const available = await this.listTransitions(issueKey);
    const target = targetStatusName.toLowerCase();
    const match = available.find((t) => t.toStatusName.toLowerCase() === target);

    if (!match) {
      // Not offered by this issue's workflow — a normal outcome, not an error. The
      // sync engine comments-and-logs the skip.
      return { status: 'unavailable', requested: targetStatusName, available };
    }

    await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      body: { transition: { id: match.id } },
    });

    return { status: 'applied', transitionId: match.id, toStatusName: match.toStatusName };
  }

  private toIssueRef(id: string, key: string): JiraIssueRef {
    return { id, key, url: `${this.baseUrl}/browse/${key}` };
  }

  /**
   * Single funnel for every HTTP call. All failures pass through here:
   * network/timeout throws become transient via asTransientNetworkError; non-2xx
   * responses become transient/permanent via classifyResponseError. With
   * `allowNotFound`, a 404 resolves to `null` instead of throwing.
   */
  private async request(
    method: string,
    path: string,
    options: { body?: unknown; allowNotFound?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (cause) {
      // No HTTP response — connection reset, DNS, timeout. Retryable.
      throw asTransientNetworkError(cause);
    }

    if (options.allowNotFound && res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const errorBody = await this.safeBody(res);
      throw classifyResponseError(res.status, errorBody, res.headers);
    }

    // 204 No Content (e.g. transitions) has no JSON body.
    if (res.status === 204) {
      return null;
    }
    return this.safeBody(res);
  }

  /** Read a response body as JSON, falling back to text; never throws. */
  private async safeBody(res: Response): Promise<unknown> {
    const text = await res.text().catch(() => '');
    if (text === '') {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      // A non-JSON body (HTML error page, etc.) is surfaced as-is in the message.
      throw new PermanentJiraError(`Unexpected non-JSON response from JIRA: ${text.slice(0, 300)}`, {
        status: res.status,
      });
    }
  }
}
