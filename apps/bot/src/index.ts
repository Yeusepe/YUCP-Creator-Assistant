// Discord bot entrypoint

import { createLogger } from '@yucp/shared';
import { ConvexHttpClient } from 'convex/browser';
import { loadEnvAsync, validateBotEnv } from './lib/env';
import { startBot } from './client';
import { registerCommands } from './commands';
import { handleInteraction } from './handlers/interactions';
import { handleGuildMemberAdd } from './handlers/guildMemberAdd';
import { RoleSyncService } from './services/roleSync';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

async function main() {
  const env = await loadEnvAsync();
  validateBotEnv(env);

  logger.info('Starting Creator Discord Bot', {
    nodeEnv: env.NODE_ENV,
    infisicalUrl: env.INFISICAL_URL,
    infisicalEnv: process.env.INFISICAL_ENV ?? 'dev (default)',
  });

  const client = await startBot(env.DISCORD_BOT_TOKEN!);

  await new Promise<void>((resolve) => {
    if (client.isReady()) {
      resolve();
    } else {
      client.once('clientReady', () => resolve());
    }
  });

  logger.info('Discord bot ready');

  // Register slash commands (global or per-guild)
  const clientId = client.user!.id;
  const guildId = env.DISCORD_GUILD_ID;
  await registerCommands(env.DISCORD_BOT_TOKEN!, clientId, guildId);
  logger.info('Slash commands registered', { guildId: guildId ?? 'global' });

  // Include MANAGE_ROLES (268435456) for role sync; 274877975552 = View Channels, Send Messages, etc.
  const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=275146411008&scope=bot%20applications.commands`;
  logger.info('Add bot to your server', { inviteUrl });

  const convex = new ConvexHttpClient(env.CONVEX_URL!);
  const interactionCtx = {
    convex,
    apiSecret: env.CONVEX_API_SECRET!,
  };

  client.on('interactionCreate', async (interaction) => {
    try {
      await handleInteraction(interaction as any, interactionCtx);
    } catch (err) {
      logger.error('Unhandled interaction error', { err });
    }
  });

  client.on('guildMemberAdd', async (member) => {
    await handleGuildMemberAdd(member, interactionCtx);
  });

  const roleSyncService = new RoleSyncService({
    discordClient: client,
    convexUrl: env.CONVEX_URL!,
    apiSecret: env.CONVEX_API_SECRET!,
    logLevel: (env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
    encryptionSecret: env.BETTER_AUTH_SECRET,
  });

  await roleSyncService.start();

  const shutdown = () => {
    logger.info('Shutting down...');
    roleSyncService.stop();
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('Failed to start Discord bot', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
