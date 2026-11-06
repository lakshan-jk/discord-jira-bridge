/**
 * Idempotent schema definition.
 *
 * This DDL is the single source of truth for the persistence layer and is safe to
 * run on every startup (`CREATE ... IF NOT EXISTS`). It is applied by `migrate()`
 * in client.ts. Kept as an inlined constant rather than a loose .sql file so it
 * ships with the compiled output and can't drift from the code that runs it.
 *
 * Two tables:
 *
 *  - event_queue: the durable inbox. Every ingested Discord event is persisted here
 *    FIRST and only acted on afterwards, so a crash can never lose an event
 *    (at-least-once by design). Rows move through pending -> processing -> done,
 *    or -> failed (dead-letter) once retries are exhausted or on a permanent error.
 *
 *  - discord_jira_map: the Discord-thread-ID -> JIRA-issue mapping (design #4). The
 *    PRIMARY KEY on discord_thread_id IS the unique constraint that provides the
 *    primary, strongly-consistent dedup: a second insert for the same thread fails
 *    loudly (unique_violation) instead of creating a duplicate Story.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS event_queue (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_key       TEXT        NOT NULL,
  event_type        TEXT        NOT NULL,
  discord_thread_id TEXT        NOT NULL,
  payload           JSONB       NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts          INTEGER     NOT NULL DEFAULT 0,
  max_attempts      INTEGER     NOT NULL DEFAULT 5,
  last_error        TEXT,
  available_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FIFO scan support: pick the earliest eligible pending row.
CREATE INDEX IF NOT EXISTS event_queue_claim_idx
  ON event_queue (project_key, id)
  WHERE status = 'pending';

-- Hard safety backstop for per-project ordering: at most ONE 'processing' row per
-- project at any time. If two workers race past the NOT EXISTS check in the claim
-- query, the second UPDATE to 'processing' violates this and that claim aborts,
-- so "one in-flight per project" is guaranteed, not merely best-effort.
CREATE UNIQUE INDEX IF NOT EXISTS event_queue_one_processing_per_project
  ON event_queue (project_key)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS discord_jira_map (
  discord_thread_id TEXT        PRIMARY KEY,
  jira_issue_key    TEXT        NOT NULL,
  jira_issue_id     TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
