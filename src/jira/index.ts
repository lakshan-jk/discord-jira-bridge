/**
 * Public surface of the JIRA client.
 *
 * This is the contract the sync engine depends on — not the concrete HTTP client —
 * so the engine can be unit-tested against a fake. Types and signatures only for
 * this step; no implementation.
 *
 * Idempotency ordering (design decision #4): callers MUST call
 * `findStoryByThreadId` before `createStory`. `createStory` stamps the thread ID
 * onto the new issue as an issue property (see DISCORD_ISSUE_PROPERTY_KEY), which
 * is what makes that find possible after local state loss. The find/create pair is
 * the backup dedup; the DB mapping with its unique constraint is the primary one.
 */

import type {
  CommentInput,
  CreateStoryInput,
  JiraIssueRef,
  JiraProject,
  JiraTransition,
  TransitionOutcome,
} from './types.js';

export type {
  CommentInput,
  CreateStoryInput,
  JiraIssueRef,
  JiraProject,
  JiraTransition,
  TransitionOutcome,
} from './types.js';
export { DISCORD_ISSUE_PROPERTY_KEY } from './types.js';

export interface JiraClient {
  /**
   * Look up a project by key. Resolves to `null` when no such project exists, so
   * the caller can log-and-skip rather than auto-create (design #3). Infra failures
   * (auth, 5xx, network) reject with a `JiraError` instead.
   */
  getProject(key: string): Promise<JiraProject | null>;

  /**
   * Find an existing Story previously stamped with this Discord thread ID, via the
   * issue property marker. Returns `null` when none exists. Call this BEFORE
   * `createStory` — it is the backup idempotency check (design #4).
   */
  findStoryByThreadId(projectKey: string, threadId: string): Promise<JiraIssueRef | null>;

  /**
   * Create a Story and, in the same operation, stamp `input.threadId` onto it as the
   * idempotency-marker issue property. Only call after `findStoryByThreadId` returns
   * `null`.
   */
  createStory(input: CreateStoryInput): Promise<JiraIssueRef>;

  /** Add a comment. `comment` is plain text; the client converts it to ADF internally. */
  addComment(issueKey: string, comment: CommentInput): Promise<void>;

  /**
   * Add labels to an existing issue. Used for the human-visible `blocked` marker
   * (design #5), which is handled as a label + comment rather than assuming a
   * custom workflow status exists.
   */
  addLabels(issueKey: string, labels: readonly string[]): Promise<void>;

  /**
   * List the transitions currently offered by an issue's workflow. Exposed because
   * transition IDs are workflow-specific and resolved at runtime, never hardcoded.
   */
  listTransitions(issueKey: string): Promise<readonly JiraTransition[]>;

  /**
   * Transition an issue to a target status *by name*. The client resolves the
   * matching transition ID at runtime from `listTransitions`. If no offered
   * transition leads to `targetStatusName`, it resolves to a `{ status: 'unavailable' }`
   * outcome (not a throw) so the engine can comment-and-log the skip (design #5).
   */
  transitionIssue(issueKey: string, targetStatusName: string): Promise<TransitionOutcome>;
}

/** Factory — the concrete HTTP implementation lives in `client.ts`. */
export { createJiraClient } from './client.js';

export interface JiraClientConfig {
  /** Atlassian site base URL, e.g. https://your-site.atlassian.net */
  readonly baseUrl: string;
  /** Service-account email for basic auth (design #1). */
  readonly email: string;
  /** API token for the service account. */
  readonly apiToken: string;
}
