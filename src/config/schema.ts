import { z } from 'zod';

/**
 * The environment contract. Every value the app reads from the environment is
 * declared here and nowhere else. `z.coerce` is used for numbers so that raw
 * string env values are converted before validation.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /** Port for the required /health endpoint. */
  PORT: z.coerce.number().int().positive().default(3000),

  /* JIRA Cloud service account (design decision #1). */
  JIRA_BASE_URL: z.string().url(),
  JIRA_EMAIL: z.string().email(),
  JIRA_API_TOKEN: z.string().min(1),

  /* Discord gateway. */
  DISCORD_BOT_TOKEN: z.string().min(1),

  /* PostgreSQL mapping store (design decision #4). */
  DATABASE_URL: z.string().url(),

  /* Historical backfill bound (design decision #7) — a configurable lookback. */
  BACKFILL_LOOKBACK_HOURS: z.coerce.number().nonnegative().default(24),
  /* Whether the startup backfill also scans archived forum threads. A plain string
     flag (zod's coerce.boolean treats any non-empty string as true, which would
     make "false" mean true). */
  BACKFILL_INCLUDE_ARCHIVED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * The shape the rest of the app consumes: a small, grouped, typed object derived
 * from the flat env. Keeping this separate from the raw env means modules depend
 * on a tidy domain config, not on env-var names.
 */
export interface Config {
  readonly env: Env['NODE_ENV'];
  readonly logLevel: Env['LOG_LEVEL'];
  readonly http: {
    readonly port: number;
  };
  readonly jira: {
    readonly baseUrl: string;
    readonly email: string;
    readonly apiToken: string;
  };
  readonly discord: {
    readonly botToken: string;
  };
  readonly database: {
    readonly url: string;
  };
  readonly backfill: {
    readonly lookbackHours: number;
    readonly includeArchived: boolean;
  };
}

/** Map validated env into the grouped Config shape. */
export function toConfig(env: Env): Config {
  return {
    env: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    http: { port: env.PORT },
    jira: {
      baseUrl: env.JIRA_BASE_URL,
      email: env.JIRA_EMAIL,
      apiToken: env.JIRA_API_TOKEN,
    },
    discord: { botToken: env.DISCORD_BOT_TOKEN },
    database: { url: env.DATABASE_URL },
    backfill: {
      lookbackHours: env.BACKFILL_LOOKBACK_HOURS,
      includeArchived: env.BACKFILL_INCLUDE_ARCHIVED,
    },
  };
}
