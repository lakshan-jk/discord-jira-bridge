/**
 * Composition root. The only file that knows how all the modules wire together:
 * build config -> connect/migrate DB -> construct JIRA client, sync engine, queue,
 * worker, and Discord ingestion -> start the /health endpoint -> run.
 *
 * Designed to boot and stay useful even without external credentials: the DB,
 * /health endpoint, and worker loop come up unconditionally; Discord ingestion is
 * attempted and, if it can't connect (e.g. a placeholder token), the service logs
 * a warning and keeps running the rest.
 */

import { config } from './config/index.js';
import { createLogger } from './lib/logger.js';
import { createDb, createEventQueue, createMappingStore, migrate } from './db/index.js';
import { createJiraClient } from './jira/index.js';
import { createSyncEngine, createResyncer } from './sync/index.js';
import { createWorker } from './worker/index.js';
import { Ingestor, createDiscordGateway } from './discord/index.js';
import { startHealthServer } from './http/health.js';

async function main(): Promise<void> {
  const logger = createLogger(config.logLevel);
  logger.info('starting jumeau-discord-jira', { env: config.env });

  // Persistence: connect and apply the idempotent schema.
  const db = createDb({ connectionString: config.database.url });
  await migrate(db);
  logger.info('database migrated');

  const mappings = createMappingStore(db);
  const queue = createEventQueue(db);

  // Domain wiring.
  const jira = createJiraClient(config.jira);
  const engine = createSyncEngine({ jira, mappings, logger });
  const worker = createWorker({ queue, engine, logger });

  // Discord ingestion. The !resync command runs the engine's idempotent create path
  // over a whole channel and replies with a summary.
  const gateway = createDiscordGateway({ botToken: config.discord.botToken, logger });
  const resyncer = createResyncer({ gateway, engine, logger });
  const ingestor = new Ingestor({
    gateway,
    queue,
    logger,
    onResyncCommand: (command) =>
      resyncer
        .resync({ channelName: command.channelName, replyChannelId: command.replyChannelId })
        .then(() => {}),
  });

  // /health comes up first so it's verifiable regardless of Discord/JIRA.
  const health = await startHealthServer({ port: config.http.port, db, logger });

  // Start the drain loop (idles harmlessly while the queue is empty).
  const workerLoop = worker.start();

  // Register signal handlers NOW — before the (possibly slow or hanging) Discord
  // connection — so SIGTERM is always handled gracefully, not just once ingestion
  // has settled. The in-flight event still settles cleanly on shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('shutting down', { signal });
    await ingestor.stop().catch(() => {}); // safe even if the gateway never connected
    await worker.stop();
    await health.close().catch(() => {});
    await db.close().catch(() => {});
    logger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Attempt Discord; degrade gracefully if credentials aren't wired up.
  let ingesting = false;
  try {
    await ingestor.start();
    const cutoff = new Date(Date.now() - config.backfill.lookbackHours * 3_600_000);
    await ingestor.backfill({ cutoff, includeArchived: config.backfill.includeArchived });
    ingesting = true;
  } catch (err) {
    logger.warn('Discord ingestion unavailable — running without it (check DISCORD_BOT_TOKEN)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  logger.info('startup complete', { ingesting, health: `http://localhost:${health.port}/health` });

  await workerLoop;
}

main().catch((err: unknown) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
