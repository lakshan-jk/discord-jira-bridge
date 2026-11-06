/**
 * Domain types for the JIRA client. These describe the client's *public* surface
 * — plain-text in, plain-domain out. No ADF and no raw REST payloads appear here;
 * those live behind the client implementation.
 */

/** The property key under which we stamp the Discord thread ID (idempotency marker). */
export const DISCORD_ISSUE_PROPERTY_KEY = 'com.jumeau.discord' as const;

/** A resolved JIRA project. `null` from `getProject` means "no such project — skip" (design #3). */
export interface JiraProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/** Lightweight reference to an issue, returned by create/find. */
export interface JiraIssueRef {
  readonly id: string;
  readonly key: string;
  /** Convenience browse URL, e.g. https://site.atlassian.net/browse/CHECKOUT-12. */
  readonly url: string;
}

/**
 * Input for creating a Story. `threadId` is the Discord thread ID that gets stamped
 * onto the issue as an issue property, so a later `findStoryByThreadId` can recover
 * the mapping even if local DB state is lost.
 */
export interface CreateStoryInput {
  readonly projectKey: string;
  readonly summary: string;
  /** Plain text; the client converts to ADF internally. */
  readonly description: string;
  /** Discord thread ID — stamped as the idempotency marker property. */
  readonly threadId: string;
  /** Optional mapped reporter (set where a JIRA account exists and perms allow, design #1). */
  readonly reporterAccountId?: string;
  /** Human-visible labels (e.g. `blocked`), distinct from the hidden thread-ID marker. */
  readonly labels?: readonly string[];
}

/** Input for a comment. Plain text + original author; the client builds ADF + attribution. */
export interface CommentInput {
  /** Display name of the originating Discord author, mentioned in the comment body (design #6). */
  readonly authorDisplayName: string;
  /** Plain-text message body; the client converts to ADF. */
  readonly body: string;
}

/** A transition offered by an issue's workflow, as returned by the transitions endpoint. */
export interface JiraTransition {
  readonly id: string;
  readonly name: string;
  /** The status this transition moves the issue *to*. */
  readonly toStatusName: string;
}

/**
 * Result of attempting a status transition. We never hardcode IDs; the client
 * resolves them at runtime against the issue's own workflow. If the requested
 * target isn't offered, the client reports `unavailable` (with what *was* offered)
 * rather than throwing — the sync engine then records a comment and logs the skip
 * (design #5), which is normal flow, not an error.
 */
export type TransitionOutcome =
  | { readonly status: 'applied'; readonly transitionId: string; readonly toStatusName: string }
  | { readonly status: 'unavailable'; readonly requested: string; readonly available: readonly JiraTransition[] };
