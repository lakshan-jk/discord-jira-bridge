/**
 * Discord ingestion layer — public surface.
 *
 * Two inputs (live gateway + bounded startup backfill), one output: normalized
 * IngestedEvents enqueued durably. The sync engine never learns which path an event
 * took. discord.js lives only behind the DiscordGateway port (gateway.ts).
 */

export { Ingestor } from './ingestor.js';
export type { BackfillOptions, IngestorDeps, IngestLogger } from './ingestor.js';
export { createDiscordGateway } from './gateway.js';
export type { GatewayConfig } from './gateway.js';
export { channelNameToProjectKey } from './mapper.js';
export {
  normalizeThreadCreated,
  normalizeMessage,
  parseStatusCommand,
  toEnqueueInput,
} from './normalize.js';
export type {
  DiscordGateway,
  BackfillQuery,
  RawAuthor,
  RawThread,
  RawMessage,
  IngestSource,
  IngestedEventType,
  IngestedEvent,
  ThreadCreatedEvent,
  CommentEvent,
  StatusCommandEvent,
} from './types.js';
