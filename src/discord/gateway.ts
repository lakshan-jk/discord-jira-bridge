/**
 * discord.js implementation of the DiscordGateway port — the thin boundary.
 *
 * This is the ONLY file that imports discord.js. It extracts the Raw* shapes from
 * discord.js objects and hands them to the (pure, tested) normalization layer; it
 * contains no normalization or enqueue logic itself. Like the pg client, it is not
 * unit-tested — it needs a live gateway — so it is kept deliberately thin.
 */

import { ChannelType, Client, Events, GatewayIntentBits } from 'discord.js';
import type { AnyThreadChannel, Message } from 'discord.js';
import type { BackfillQuery, DiscordGateway, RawMessage, RawThread } from './types.js';

export interface GatewayConfig {
  readonly botToken: string;
}

export function createDiscordGateway(config: GatewayConfig): DiscordGateway {
  return new DiscordJsGateway(config);
}

class DiscordJsGateway implements DiscordGateway {
  private readonly client: Client;
  private readonly token: string;
  private threadHandler?: (thread: RawThread) => Promise<void>;
  private messageHandler?: (message: RawMessage) => Promise<void>;

  constructor(config: GatewayConfig) {
    this.token = config.botToken;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // Without a listener, a client 'error' (e.g. a bad token) is thrown as an
    // unhandled EventEmitter error and crashes the process. Swallow it here so the
    // rest of the service (health, worker) keeps running; login failures are
    // surfaced via the rejected start() promise instead.
    this.client.on(Events.Error, () => {});

    this.client.on(Events.ThreadCreate, (thread) => {
      void this.dispatchThread(thread);
    });
    this.client.on(Events.MessageCreate, (message) => {
      void this.messageHandler?.(this.toRawMessage(message));
    });
  }

  onThreadCreated(handler: (thread: RawThread) => Promise<void>): void {
    this.threadHandler = handler;
  }

  onMessageCreated(handler: (message: RawMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    await this.client.login(this.token);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  async listThreads(query: BackfillQuery): Promise<readonly RawThread[]> {
    const raw: RawThread[] = [];
    for (const guild of this.client.guilds.cache.values()) {
      const forums = guild.channels.cache.filter((c) => c.type === ChannelType.GuildForum);
      for (const forum of forums.values()) {
        if (forum.type !== ChannelType.GuildForum) {
          continue;
        }
        const active = await forum.threads.fetchActive();
        for (const thread of active.threads.values()) {
          raw.push(await this.toRawThread(thread));
        }
        if (query.includeArchived) {
          const archived = await forum.threads.fetchArchived();
          for (const thread of archived.threads.values()) {
            raw.push(await this.toRawThread(thread));
          }
        }
      }
    }
    return raw;
  }

  async listMessages(threadId: string): Promise<readonly RawMessage[]> {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel || !channel.isThread()) {
      return [];
    }
    const collection = await channel.messages.fetch({ limit: 100 });
    // discord.js returns newest-first; reverse to oldest-first for ordered enqueue.
    return [...collection.values()].reverse().map((m) => this.toRawMessage(m));
  }

  private async dispatchThread(thread: AnyThreadChannel): Promise<void> {
    if (!this.threadHandler) {
      return;
    }
    await this.threadHandler(await this.toRawThread(thread));
  }

  private async toRawThread(thread: AnyThreadChannel): Promise<RawThread> {
    const parent = thread.parent;
    const parentIsForum = parent?.type === ChannelType.GuildForum;
    const starter = await thread.fetchStarterMessage().catch(() => null);
    return {
      id: thread.id,
      name: thread.name,
      parentChannelName: parentIsForum ? parent.name : null,
      createdAt: thread.createdAt ?? new Date(0),
      archived: thread.archived ?? false,
      ownerDisplayName: displayNameOf(starter),
      starterMessageContent: starter?.content ?? '',
    };
  }

  private toRawMessage(message: Message): RawMessage {
    const channel = message.channel;
    const parent = channel.isThread() ? channel.parent : null;
    const parentIsForum = parent?.type === ChannelType.GuildForum;
    return {
      id: message.id,
      threadId: channel.id,
      parentChannelName: parentIsForum ? parent.name : null,
      author: {
        id: message.author.id,
        displayName: displayNameOf(message),
        isBot: message.author.bot,
      },
      content: message.content,
      createdAt: message.createdAt,
      isSystem: message.system,
      // For forum posts the starter message shares the thread's id.
      isThreadStarter: message.id === channel.id,
    };
  }
}

/** Best-effort human display name from a message. */
function displayNameOf(message: Message | null): string {
  if (!message) {
    return 'unknown';
  }
  return message.member?.displayName ?? message.author.globalName ?? message.author.username;
}
