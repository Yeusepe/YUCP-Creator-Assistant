import { createLogger } from '@yucp/shared';
import { Client, GatewayIntentBits } from 'discord.js';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export function createBotClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
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
