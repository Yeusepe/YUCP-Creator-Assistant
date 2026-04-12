// Discord bot entrypoint

import { setDefaultResultOrder } from 'node:dns';
import { SpanKind } from '@opentelemetry/api';
import { createLogger } from '@yucp/shared';
import { ConvexHttpClient } from 'convex/browser';
import { startBot } from './client';
import { registerCommands } from './commands';
import { handleGuildMemberAdd } from './handlers/guildMemberAdd';
import { handleInteraction } from './handlers/interactions';
import { loadEnvAsync, validateBotEnv } from './lib/env';
import { initBotObservability, withBotSpan } from './lib/observability';
import { startHeartbeat } from './services/heartbeat';
import {
  getLienedDownloadsInvitePermissions,
  LienedDownloadsService,
} from './services/lienedDownloads';
import { RoleSyncService } from './services/roleSync';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function getInteractionSpanName(interaction: Parameters<typeof handleInteraction>[0]) {
  if (interaction.isChatInputCommand() || interaction.isAutocomplete()) {
    return interaction.commandName;
  }

  if (
    interaction.isButton() ||
    interaction.isModalSubmit() ||
    interaction.isStringSelectMenu() ||
    interaction.isRoleSelectMenu() ||
    interaction.isChannelSelectMenu() ||
    interaction.isUserSelectMenu()
  ) {
    return interaction.customId;
  }

  return 'unknown';
}

async function discordPreflight(token: string): Promise<void> {
  const headers = {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
  };

  // Validates egress + bot token before gateway login.
  const meResponse = await fetchWithTimeout(
    'https://discord.com/api/v10/users/@me',
    { method: 'GET', headers },
    10_000
  );
  if (!meResponse.ok) {
    const body = (await meResponse.text()).slice(0, 300);
    throw new Error(
      `Discord preflight /users/@me failed: HTTP ${meResponse.status} ${meResponse.statusText}; body=${body}`
    );
  }

  const gatewayResponse = await fetchWithTimeout(
    'https://discord.com/api/v10/gateway/bot',
    { method: 'GET', headers },
    10_000
  );
  if (!gatewayResponse.ok) {
    const body = (await gatewayResponse.text()).slice(0, 300);
    if (gatewayResponse.status >= 500) {
      logger.warn(
        'Discord preflight /gateway/bot returned transient server error; continuing to login',
        {
          gatewayStatus: gatewayResponse.status,
          gatewayStatusText: gatewayResponse.statusText,
          gatewayBody: body,
        }
      );
      logger.info('Discord preflight passed with degraded gateway metadata check', {
        meStatus: meResponse.status,
        gatewayStatus: gatewayResponse.status,
      });
      return;
    }

    throw new Error(
      `Discord preflight /gateway/bot failed: HTTP ${gatewayResponse.status} ${gatewayResponse.statusText}; body=${body}`
    );
  }

  logger.info('Discord preflight passed', {
    meStatus: meResponse.status,
    gatewayStatus: gatewayResponse.status,
  });
}

async function main() {
  const env = await loadEnvAsync();
  initBotObservability(process.env);
  validateBotEnv(env);
  const discordBotToken = env.DISCORD_BOT_TOKEN;
  const convexUrl = env.CONVEX_URL;
  const convexApiSecret = env.CONVEX_API_SECRET;
  if (!discordBotToken || !convexUrl || !convexApiSecret) {
    throw new Error('Missing required bot env vars after validation');
  }

  logger.info('Starting Creator Discord Bot', {
    nodeEnv: env.NODE_ENV,
    infisicalUrl: env.INFISICAL_URL,
    infisicalEnv: process.env.INFISICAL_ENV ?? 'dev (default)',
  });

  try {
    setDefaultResultOrder('ipv4first');
    logger.info('DNS resolution order set', { order: 'ipv4first' });
  } catch (err) {
    logger.warn('Failed to set DNS resolution order', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  await withBotSpan(
    'discord.preflight',
    {
      phase: 'discord-preflight',
    },
    () => discordPreflight(discordBotToken)
  );

  const LOGIN_TIMEOUT_MS = Number.parseInt(process.env.BOT_LOGIN_TIMEOUT_MS ?? '30000', 10);
  const client = await withBotSpan(
    'discord.login',
    {
      phase: 'discord-login',
    },
    () => withTimeout(startBot(discordBotToken), LOGIN_TIMEOUT_MS, 'Discord login')
  );

  const READY_TIMEOUT_MS = 30_000;

  await new Promise<void>((resolve, reject) => {
    if (client.isReady()) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      client.removeListener('clientReady', onReady);
      client.removeListener('error', onError);
      reject(
        new Error(
          `Discord client did not become ready within ${READY_TIMEOUT_MS / 1000}s. Possible causes: rate limiting (429), invalid token, or network issues. Check logs for Discord client error/warn events.`
        )
      );
    }, READY_TIMEOUT_MS);

    const onReady = () => {
      clearTimeout(timeout);
      client.removeListener('error', onError);
      resolve();
    };

    const onError = (err: Error) => {
      clearTimeout(timeout);
      client.removeListener('clientReady', onReady);
      reject(new Error(`Discord client error before ready: ${err.message}`, { cause: err }));
    };

    client.once('clientReady', onReady);
    client.once('error', onError);
  });

  logger.info('Discord bot ready');

  // Register slash commands (global or per-guild)
  const clientId = client.user?.id;
  if (!clientId) {
    throw new Error('Discord client is ready but user ID is missing');
  }
  const guildId = env.DISCORD_GUILD_ID;
  await withBotSpan(
    'discord.register_commands',
    {
      clientId,
      guildId: guildId ?? 'global',
    },
    () => registerCommands(discordBotToken, clientId, guildId)
  );
  logger.info('Slash commands registered', { guildId: guildId ?? 'global' });

  const invitePermissions = getLienedDownloadsInvitePermissions();
  const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${invitePermissions.toString()}&scope=bot%20applications.commands`;
  logger.info('Add bot to your server', { inviteUrl });

  const convex = new ConvexHttpClient(convexUrl);
  const interactionCtx = {
    convex,
    apiSecret: convexApiSecret,
  };
  const lienedDownloadsService = new LienedDownloadsService(client, convex, convexApiSecret);

  client.on('interactionCreate', async (interaction) => {
    try {
      if (
        interaction.isChatInputCommand() ||
        interaction.isButton() ||
        interaction.isModalSubmit() ||
        interaction.isStringSelectMenu() ||
        interaction.isRoleSelectMenu() ||
        interaction.isAutocomplete() ||
        interaction.isChannelSelectMenu() ||
        interaction.isUserSelectMenu()
      ) {
        await withBotSpan(
          'discord.interaction',
          {
            interactionType: interaction.type,
            commandName: getInteractionSpanName(interaction),
            guildId: interaction.guildId ?? 'dm',
            userId: interaction.user.id,
          },
          () => handleInteraction(interaction, interactionCtx),
          SpanKind.CONSUMER
        );
      }
    } catch (err) {
      logger.error('Unhandled interaction error', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  });

  client.on('guildMemberAdd', async (member) => {
    await withBotSpan(
      'discord.guild_member_add',
      {
        guildId: member.guild.id,
        userId: member.user.id,
      },
      () => handleGuildMemberAdd(member, interactionCtx),
      SpanKind.CONSUMER
    );
  });

  client.on('messageCreate', async (message) => {
    try {
      await withBotSpan(
        'discord.message',
        {
          guildId: message.guildId ?? 'dm',
          channelId: message.channelId,
          authorId: message.author.id,
        },
        () => lienedDownloadsService.handleMessage(message),
        SpanKind.CONSUMER
      );
    } catch (err) {
      logger.error('Liened Downloads message handler failed', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  });

  const roleSyncService = new RoleSyncService({
    discordClient: client,
    convexUrl,
    apiSecret: convexApiSecret,
    logLevel: (env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
    encryptionSecret: env.BETTER_AUTH_SECRET,
  });

  await roleSyncService.start();

  const stopHeartbeat = startHeartbeat(
    env.HEARTBEAT_URL,
    parseFloat(process.env.HEARTBEAT_INTERVAL_MINUTES ?? '5')
  );

  const shutdown = () => {
    logger.info('Shutting down...');
    try {
      if (typeof stopHeartbeat === 'function') {
        stopHeartbeat();
      }
    } catch (err) {
      logger.warn('Error stopping heartbeat', {
        message: err instanceof Error ? err.message : String(err),
      });
    }

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
