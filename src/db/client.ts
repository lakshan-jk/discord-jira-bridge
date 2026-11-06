/**
 * PostgreSQL connection + schema init. The only place that imports `pg`.
 */

import pg from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { SCHEMA_SQL } from './schema.js';

/** Narrow DB surface the repositories use; keeps them off the raw pg types. */
export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
  close(): Promise<void>;
}

export interface DbConfig {
  readonly connectionString: string;
}

class PgDb implements Db {
  constructor(private readonly pool: pg.Pool) {}

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    // pg types want a mutable array; the caller's params are treated read-only here.
    return this.pool.query<R>(text, params as unknown[]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createDb(config: DbConfig): Db {
  const pool = new pg.Pool({ connectionString: config.connectionString });
  return new PgDb(pool);
}

/**
 * Apply the schema. Idempotent (CREATE ... IF NOT EXISTS), so it is safe to run on
 * every startup. Runs as a single multi-statement command inside an implicit
 * transaction.
 */
export async function migrate(db: Db): Promise<void> {
  await db.query(SCHEMA_SQL);
}
