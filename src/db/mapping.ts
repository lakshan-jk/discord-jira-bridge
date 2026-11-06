/**
 * PostgreSQL-backed Discord->JIRA mapping store (design #4). Parameterised queries.
 *
 * `insert` leans on the PRIMARY KEY (discord_thread_id) as the primary dedup: a
 * second insert for the same thread raises Postgres unique_violation (23505), which
 * we surface as DuplicateMappingError so the sync engine can treat it as "already
 * created" and NEVER produce a second Story. We deliberately do NOT use
 * ON CONFLICT DO NOTHING here — the duplicate must fail loudly, not vanish.
 */

import type { Db } from './client.js';
import {
  DuplicateMappingError,
  type DiscordJiraMapping,
  type InsertMappingInput,
  type MappingStore,
} from './types.js';

const PG_UNIQUE_VIOLATION = '23505';

interface MappingRow {
  discord_thread_id: string;
  jira_issue_key: string;
  jira_issue_id: string;
  created_at: Date;
}

function rowToMapping(row: MappingRow): DiscordJiraMapping {
  return {
    discordThreadId: row.discord_thread_id,
    jiraIssueKey: row.jira_issue_key,
    jiraIssueId: row.jira_issue_id,
    createdAt: row.created_at,
  };
}

export function createMappingStore(db: Db): MappingStore {
  return new PgMappingStore(db);
}

class PgMappingStore implements MappingStore {
  constructor(private readonly db: Db) {}

  async insert(input: InsertMappingInput): Promise<DiscordJiraMapping> {
    try {
      const res = await this.db.query<MappingRow>(
        `INSERT INTO discord_jira_map (discord_thread_id, jira_issue_key, jira_issue_id)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [input.discordThreadId, input.jiraIssueKey, input.jiraIssueId],
      );
      return rowToMapping(res.rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new DuplicateMappingError(input.discordThreadId);
      }
      throw err;
    }
  }

  async findByThreadId(discordThreadId: string): Promise<DiscordJiraMapping | null> {
    const res = await this.db.query<MappingRow>(
      `SELECT * FROM discord_jira_map WHERE discord_thread_id = $1`,
      [discordThreadId],
    );
    const row = res.rows[0];
    return row ? rowToMapping(row) : null;
  }
}
