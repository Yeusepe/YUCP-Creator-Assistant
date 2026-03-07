import { createLogger } from '@yucp/shared';
import { Client, GatewayIntentBits } from 'discord.js';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export function createBotClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on('error', (err) => {
    logger.error('Discord client error', {
      message: err.message,
      code: (err as { code?: string }).code,
    });
  });

  client.on('warn', (info) => {
    logger.warn('Discord client warn', { info: String(info) });
  });

  client.on('shardError', (error, shardId) => {
    logger.error('Discord shard error', {
      shardId,
      message: error?.message,
      stack: error?.stack,
    });
  });

  client.on('shardDisconnect', (event, shardId) => {
    logger.warn('Discord shard disconnected', {
      shardId,
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
  });

  client.on('shardReconnecting', (shardId) => {
    logger.warn('Discord shard reconnecting', { shardId });
  });

  client.on('shardResume', (shardId, replayedEvents) => {
    logger.info('Discord shard resumed', { shardId, replayedEvents });
  });

  client.on('invalidated', () => {
    logger.error('Discord session invalidated');
  });

  if (process.env.LOG_LEVEL === 'debug') {
    client.on('debug', (info) => {
      logger.debug('Discord', { info: String(info) });
    });
  }

  return client;
}

export async function startBot(token: string): Promise<Client> {
  const client = createBotClient();
  await client.login(token);
  return client;
}
