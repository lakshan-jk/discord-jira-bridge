/**
 * Async job queue.
 *
 * Decouples Discord ingestion from JIRA writes and owns retry/backoff, branching on
 * the transient-vs-permanent distinction from lib/errors. Starts as an in-process,
 * Postgres-backed job table (Redis documented as a path to production).
 * Implementation lands in a later step.
 */
export {};
