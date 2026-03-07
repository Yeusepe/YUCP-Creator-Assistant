import {
  ActionRowBuilder,
  AttachmentBuilder,
  type Attachment,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Collection,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type ButtonInteraction,
  type Client,
  type ForumChannel,
  type Message,
  type TextBasedChannel,
  type ThreadChannel,
} from 'discord.js';
import { ConvexHttpClient } from 'convex/browser';
import { createLogger } from '@yucp/shared';
import { E } from '../lib/emojis';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const DOWNLOAD_BUTTON_PREFIX = 'creator_download:artifact:';
const AUTOFIX_PROMPT_BUTTON_PREFIX = 'creator_download:autofix_prompt:';
const AUTOFIX_RUN_BUTTON_PREFIX = 'creator_download:autofix_run:';
const AUTOFIX_CANCEL_BUTTON_PREFIX = 'creator_download:autofix_cancel:';
const RELAY_WEBHOOK_NAME = 'Liened Downloads Relay';

type DownloadRoute = {
  _id: string;
  tenantId: string;
  guildId: string;
  guildLinkId: string;
  sourceChannelId: string;
  archiveChannelId: string;
  messageTitle: string;
  messageBody: string;
  requiredRoleIds: string[];
  roleLogic: 'all' | 'any';
  allowedExtensions: string[];
  enabled: boolean;
};

type DownloadArtifact = {
  _id: string;
  guildId: string;
  routeId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  sourceMessageUrl: string;
  sourceRelayMessageId?: string;
  sourceDeliveryMode?: 'reply' | 'webhook';
  requiredRoleIds: string[];
  roleLogic: 'all' | 'any';
  files: Array<{
    filename: string;
    url: string;
    extension: string;
    contentType?: string;
    size?: number;
  }>;
  status: 'active' | 'deleted' | 'failed';
};

type MatchedFile = {
  attachment: Attachment;
  extension: string;
};

type BackfillStats = {
  scannedMessages: number;
  securedMessages: number;
  skippedMessages: number;
  failedMessages: number;
  manualCleanupMessages: Array<{
    sourceMessageId: string;
    sourceMessageUrl: string;
  }>;
};

function describeAttachments(message: Message): string[] {
  return [...message.attachments.values()].map((attachment) => {
    const name = attachment.name ?? 'unnamed';
    const extension = getExtension(name) ?? 'none';
    return `${name} (ext=${extension}, contentType=${attachment.contentType ?? 'unknown'})`;
  });
}

function getExtension(filename: string): string | null {
  const idx = filename.lastIndexOf('.');
  if (idx === -1 || idx === filename.length - 1) return null;
  return filename.slice(idx + 1).toLowerCase();
}

function getMatchingFiles(message: Message, route: DownloadRoute): MatchedFile[] {
  const allowed = new Set(route.allowedExtensions.map((ext) => ext.toLowerCase()));
  return [...message.attachments.values()]
    .map((attachment) => {
      const extension = getExtension(attachment.name ?? '');
      return extension && allowed.has(extension)
        ? { attachment, extension }
        : null;
    })
    .filter((entry): entry is MatchedFile => Boolean(entry));
}

function selectRoute(routes: DownloadRoute[], channelId: string, parentId: string | null): DownloadRoute | null {
  const exact = routes.filter((route) => route.sourceChannelId === channelId);
  if (exact.length > 0) return exact[0] ?? null;
  if (parentId) {
    const inherited = routes.filter((route) => route.sourceChannelId === parentId);
    if (inherited.length > 0) return inherited[0] ?? null;
  }
  return null;
}

async function fetchAttachmentBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch attachment: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function buildRelayFiles(message: Message, matchedFiles: MatchedFile[]): Promise<AttachmentBuilder[]> {
  const securedAttachmentIds = new Set(matchedFiles.map(({ attachment }) => attachment.id));
  const relayAttachments = [...message.attachments.values()].filter(
    (attachment) => !securedAttachmentIds.has(attachment.id),
  );

  return await Promise.all(
    relayAttachments.map(async (attachment) => {
      const buffer = await fetchAttachmentBuffer(attachment.url);
      return new AttachmentBuilder(buffer, { name: attachment.name ?? 'attachment.bin' });
    }),
  );
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function buildReplacementContainer(
  route: DownloadRoute,
  artifactId: string,
  matchedFiles: MatchedFile[],
  originalContent?: string | null,
  note?: string,
): ContainerBuilder {
  const fileList = matchedFiles
    .map(({ attachment }) => `• \`${truncateText(attachment.name ?? 'download.bin', 72)}\``)
    .join('\n');
  const accessLabel = route.roleLogic === 'all' ? 'You need every role below.' : 'Any one of these roles works.';
  const rolesList = route.requiredRoleIds.map((roleId) => `<@&${roleId}>`).join(', ');

  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${E.Key} ${route.messageTitle}`),
    new TextDisplayBuilder().setContent(route.messageBody),
  );

  if (originalContent?.trim()) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(truncateText(originalContent.trim(), 1200)),
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );

  container.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**${E.Bag} Files**\n${fileList}`),
        new TextDisplayBuilder().setContent(`**${E.Key} Access**\n${accessLabel}\n${rolesList}`),
      )
      .setButtonAccessory(
        new ButtonBuilder()
          .setCustomId(`${DOWNLOAD_BUTTON_PREFIX}${artifactId}`)
          .setLabel('Download')
          .setStyle(ButtonStyle.Primary),
      ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# ${E.Assistant} Discord sends the file privately after access is confirmed.`),
  );

  if (note) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${note}`),
    );
  }

  return container;
}

async function resolveWebhookChannel(
  channel: TextBasedChannel | ThreadChannel,
  configuredSourceChannelId?: string | null,
) {
  if (!channel.isThread()) {
    return {
      webhookChannel: channel,
      threadId: undefined as string | undefined,
    };
  }

  const freshThread = await channel.fetch().catch(() => channel);
  const parentId = freshThread.parentId ?? channel.parentId ?? configuredSourceChannelId ?? null;
  const parent =
    freshThread.parent ??
    channel.parent ??
    (parentId ? await channel.client.channels.fetch(parentId).catch(() => null) : null);

  if (!parent || !('createWebhook' in parent) || !('fetchWebhooks' in parent)) {
    throw new Error(
      `Thread ${channel.id} has no webhook-capable parent channel (parentId=${parentId ?? 'null'}, configuredSourceChannelId=${configuredSourceChannelId ?? 'null'}, parentType=${parent?.type ?? 'null'})`,
    );
  }

  return {
    webhookChannel: parent,
    threadId: channel.id,
  };
}

async function getOrCreateRelayWebhook(client: Client, channel: any) {
  const permissions = typeof channel.permissionsFor === 'function'
    ? channel.permissionsFor(client.user?.id ?? null)
    : null;
  if (!permissions?.has(PermissionsBitField.Flags.ManageWebhooks)) {
    throw new Error(`Missing Manage Webhooks permission in channel ${channel.id}`);
  }

  if (typeof channel.fetchWebhooks !== 'function' || typeof channel.createWebhook !== 'function') {
    throw new Error(`Channel ${channel.id} does not support webhooks`);
  }

  const existing = (await channel.fetchWebhooks()).find((webhook: any) =>
    webhook.name === RELAY_WEBHOOK_NAME && webhook.owner?.id === client.user?.id,
  );
  if (existing) return existing;

  return await channel.createWebhook({
    name: RELAY_WEBHOOK_NAME,
    reason: 'Liened Downloads secure relay',
  });
}

async function relaySecureMessage(
  client: Client,
  message: Message,
  route: DownloadRoute,
  artifactId: string,
  matchedFiles: MatchedFile[],
) {
  const permissions = typeof (message.channel as any).permissionsFor === 'function'
    ? (message.channel as any).permissionsFor(client.user?.id ?? null)
    : null;
  if (!permissions?.has(PermissionsBitField.Flags.ViewChannel)) {
    throw new Error(`Missing View Channel permission in source channel ${message.channelId}`);
  }
  if (!permissions?.has(PermissionsBitField.Flags.SendMessages)) {
    throw new Error(`Missing Send Messages permission in source channel ${message.channelId}`);
  }
  if (message.channel.isThread() && !permissions?.has(PermissionsBitField.Flags.SendMessagesInThreads)) {
    throw new Error(`Missing Send Messages in Threads permission in source thread ${message.channelId}`);
  }

  const { webhookChannel, threadId } = await resolveWebhookChannel(message.channel, route.sourceChannelId);
  const webhook = await getOrCreateRelayWebhook(client, webhookChannel);
  const username = (message.member?.displayName ?? message.author.globalName ?? message.author.username)
    .replace(/discord/gi, 'user')
    .replace(/clyde/gi, 'user')
    .slice(0, 80) || 'user';
  const relayFiles = await buildRelayFiles(message, matchedFiles);

  return await webhook.send({
    username,
    avatarURL: message.author.displayAvatarURL({ extension: 'png', size: 128 }),
    components: [buildReplacementContainer(route, artifactId, matchedFiles, message.content)],
    flags: MessageFlags.IsComponentsV2,
    files: relayFiles,
    threadId,
    allowedMentions: { parse: [] },
  });
}

async function postBackfillReply(
  message: Message,
  route: DownloadRoute,
  artifactId: string,
  matchedFiles: MatchedFile[],
  options?: {
    note?: string;
  },
) {
  return await message.reply({
    components: [
      buildReplacementContainer(
        route,
        artifactId,
        matchedFiles,
        message.content,
        options?.note,
      ),
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
}

function buildArchiveAutofixNotice(artifact: DownloadArtifact): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(0xfaa61a)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${E.Wrench} Attachment Cleanup Needed`),
      new TextDisplayBuilder().setContent('A protected file was prepared, but the original post still includes the attachment.'),
    )
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**${E.Link} Source message**\n${artifact.sourceMessageUrl}`),
          new TextDisplayBuilder().setContent(`**${E.Assistant} Action**\nRemove the original attachment manually, or use Autofix to replace the message.`),
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`${AUTOFIX_PROMPT_BUTTON_PREFIX}${artifact._id}`)
            .setLabel('Autofix...')
            .setStyle(ButtonStyle.Secondary),
        ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${E.X_} Autofix deletes the original post and breaks image previews in forum posts.`),
    );
}

async function postArchiveAutofixNotice(
  client: Client,
  route: DownloadRoute,
  artifact: DownloadArtifact,
  archiveThreadId?: string,
): Promise<void> {
  const archiveChannel = await client.channels.fetch(route.archiveChannelId).catch(() => null);
  if (!archiveChannel) return;

  if (archiveThreadId) {
    const archiveThread = await client.channels.fetch(archiveThreadId).catch(() => null);
    if (archiveThread?.isTextBased() && 'send' in archiveThread) {
      await (archiveThread as any).send({
        components: [buildArchiveAutofixNotice(artifact)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
      }).catch(() => null);
      return;
    }
  }

  if (archiveChannel.isTextBased() && 'send' in archiveChannel) {
    await (archiveChannel as any).send({
      components: [buildArchiveAutofixNotice(artifact)],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    }).catch(() => null);
  }
}

function buildSingleAutofixConfirmRow(artifactId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${AUTOFIX_RUN_BUTTON_PREFIX}${artifactId}`)
      .setLabel('Replace Message')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${AUTOFIX_CANCEL_BUTTON_PREFIX}${artifactId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
}

async function postToArchive(
  client: Client,
  route: DownloadRoute,
  message: Message,
  matchedFiles: MatchedFile[],
) {
  const archiveChannel = await client.channels.fetch(route.archiveChannelId);
  if (!archiveChannel) {
    throw new Error(`Archive channel ${route.archiveChannelId} is not accessible`);
  }

  const files = await Promise.all(
    matchedFiles.map(async ({ attachment }) => {
      const buffer = await fetchAttachmentBuffer(attachment.url);
      return new AttachmentBuilder(buffer, { name: attachment.name ?? 'download.bin' });
    }),
  );

  const content =
    `${E.Library} Liened Downloads archive\n` +
    `${E.Assistant} Uploader: <@${message.author.id}>\n` +
    `${E.Link} Source: ${message.url}\n` +
    `${E.Key} Access: ${route.roleLogic === 'all' ? 'All selected roles' : 'Any selected role'}\n` +
    `${E.Point} Roles: ${route.requiredRoleIds.map((roleId) => `<@&${roleId}>`).join(', ')}`;

  if ('type' in archiveChannel && archiveChannel.type === ChannelType.GuildForum) {
    const forum = archiveChannel as ForumChannel;
    const thread = await forum.threads.create({
      name: `${message.author.username}-${Date.now()}`.slice(0, 90),
      message: {
        content,
        files,
      },
    });
    const starter = await thread.fetchStarterMessage().catch(() => null);
    return {
      sentMessage: starter,
      archiveChannelId: route.archiveChannelId,
      archiveThreadId: thread.id,
    };
  }

  if (!archiveChannel.isTextBased() || !('send' in archiveChannel)) {
    throw new Error(`Archive channel ${route.archiveChannelId} is not writable`);
  }

  const sentMessage = await (archiveChannel as any).send({
    content,
    files,
  });
  return {
    sentMessage,
    archiveChannelId: route.archiveChannelId,
    archiveThreadId: undefined,
  };
}

function buildAllowedDownloadEmbed(artifact: DownloadArtifact): EmbedBuilder {
  const lines = artifact.files.map((file) => `• [${file.filename}](${file.url})`);
  return new EmbedBuilder()
    .setTitle(`${E.Checkmark} Download Ready`)
    .setColor(0x57f287)
    .setDescription(['Your download is ready.', '', ...lines].join('\n'));
}

function formatRoleRequirement(artifact: DownloadArtifact): string {
  const mentions = artifact.requiredRoleIds.map((roleId) => `<@&${roleId}>`).join(', ');
  return artifact.roleLogic === 'all'
    ? `You need all of these roles to open this download:\n${mentions}`
    : `You need at least one of these roles to open this download:\n${mentions}`;
}

async function maybeUnarchiveThread(channel: TextBasedChannel | ThreadChannel): Promise<(() => Promise<void>) | null> {
  if (!channel.isThread()) return null;
  const thread = channel as ThreadChannel;
  if (!thread.archived) return null;
  if (!thread.manageable) {
    throw new Error(`Thread ${thread.id} is archived and cannot be unarchived by the bot`);
  }

  const wasLocked = thread.locked;
  await thread.setArchived(false, 'Liened Downloads retroactive secure delivery');

  return async () => {
    try {
      await thread.setArchived(true, 'Restore archived state after Liened Downloads processing');
      if (wasLocked !== null && wasLocked !== thread.locked && thread.manageable) {
        await thread.setLocked(wasLocked, 'Restore locked state after Liened Downloads processing');
      }
    } catch {
      // Ignore restore failures.
    }
  };
}

async function iterateMessages(channel: TextBasedChannel | ThreadChannel): Promise<Message[]> {
  const messages: Message[] = [];
  let before: string | undefined;

  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    messages.push(...batch.values());
    before = batch.last()?.id;
    if (!before) break;
  }

  return messages.reverse();
}

export class LienedDownloadsService {
  constructor(
    private readonly client: Client,
    private readonly convex: ConvexHttpClient,
    private readonly apiSecret: string,
  ) {}

  private async isForumRouteMessage(message: Message, route: DownloadRoute): Promise<boolean> {
    if (!message.channel.isThread()) return false;
    const sourceChannel = await this.client.channels.fetch(route.sourceChannelId).catch(() => null);
    return sourceChannel?.type === ChannelType.GuildForum;
  }

  private async secureMessage(
    message: Message,
    route: DownloadRoute,
    mode: 'replace' | 'reply' = 'replace',
  ): Promise<'secured' | 'skipped'> {
    if (!message.inGuild() || message.author.bot || message.webhookId) return 'skipped';
    if (message.attachments.size === 0) return 'skipped';

    const existingArtifact = await this.convex.query('downloads:getArtifactBySourceMessage' as any, {
      apiSecret: this.apiSecret,
      sourceMessageId: message.id,
    }) as { _id: string } | null;
    if (existingArtifact) {
      logger.info('Liened Downloads skipped message because it is already secured', {
        feature: 'Liened Downloads',
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        attachments: describeAttachments(message),
      });
      return 'skipped';
    }

    const matchedFiles = getMatchingFiles(message, route);
    if (matchedFiles.length === 0) {
      logger.info('Liened Downloads skipped message because no attachments matched the route extensions', {
        feature: 'Liened Downloads',
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        allowedExtensions: route.allowedExtensions,
        attachments: describeAttachments(message),
      });
      return 'skipped';
    }

    const archiveResult = await postToArchive(this.client, route, message, matchedFiles);
    if (!archiveResult.sentMessage) {
      throw new Error('Archive message could not be resolved');
    }

    const artifact = (await this.convex.mutation('downloads:createArtifact' as any, {
      apiSecret: this.apiSecret,
      tenantId: route.tenantId,
      guildId: route.guildId,
      routeId: route._id,
      sourceChannelId: message.channelId,
      sourceMessageId: message.id,
      sourceMessageUrl: message.url,
      sourceAuthorId: message.author.id,
      archiveChannelId: archiveResult.archiveChannelId,
      archiveMessageId: archiveResult.sentMessage.id,
      archiveThreadId: archiveResult.archiveThreadId,
      sourceDeliveryMode: mode === 'replace' ? 'webhook' : 'reply',
      requiredRoleIds: route.requiredRoleIds,
      roleLogic: route.roleLogic,
      files: [...archiveResult.sentMessage.attachments.values()].map((attachment) => ({
        filename: attachment.name ?? 'download.bin',
        url: attachment.url,
        size: attachment.size,
        contentType: attachment.contentType ?? undefined,
        extension: getExtension(attachment.name ?? '') ?? 'bin',
      })),
    })) as { artifactId: string };

    let replacementMessage: Message | null = null;
    const restoreArchivedState = await maybeUnarchiveThread(message.channel);
    const forumRouteMessage = await this.isForumRouteMessage(message, route);
    try {
      replacementMessage = mode === 'replace'
        ? await relaySecureMessage(this.client, message, route, artifact.artifactId, matchedFiles)
        : await postBackfillReply(message, route, artifact.artifactId, matchedFiles);
      if (!replacementMessage) {
        throw new Error('Replacement message could not be created');
      }

      await this.convex.mutation('downloads:updateArtifactSourceRelay' as any, {
        apiSecret: this.apiSecret,
        artifactId: artifact.artifactId,
        sourceRelayMessageId: replacementMessage.id,
        sourceDeliveryMode: mode === 'replace' ? 'webhook' : 'reply',
      });
    } finally {
      if (restoreArchivedState) {
        await restoreArchivedState();
      }
    }

    if (mode === 'replace') {
      try {
        await message.delete();
      } catch (error) {
        try {
          if (replacementMessage) {
            await replacementMessage.delete().catch(() => null);
          }
          await this.convex.mutation('downloads:markArtifactStatus' as any, {
            apiSecret: this.apiSecret,
            artifactId: artifact.artifactId,
            status: 'failed',
          });
        } catch {
          // Ignore cleanup failure.
        }
        throw new Error(`Failed to delete original message after webhook relay: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (mode === 'reply' && forumRouteMessage) {
      const artifactRecord = (await this.convex.query('downloads:getArtifactForDelivery' as any, {
        apiSecret: this.apiSecret,
        artifactId: artifact.artifactId,
      })) as DownloadArtifact | null;
      if (artifactRecord) {
        await postArchiveAutofixNotice(this.client, route, artifactRecord, archiveResult.archiveThreadId);
      }
    }

    logger.info('Liened Downloads secured message', {
      feature: 'Liened Downloads',
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      mode,
      matchedFiles: matchedFiles.map(({ attachment }) => attachment.name ?? 'download.bin'),
    });
    return 'secured';
  }

  async handleMessage(message: Message): Promise<void> {
    if (!message.inGuild() || message.author.bot || message.webhookId) return;
    if (message.attachments.size === 0) return;

    const parentId = 'parentId' in message.channel ? message.channel.parentId ?? null : null;
    const routes = (await this.convex.query('downloads:getActiveRoutesForChannel' as any, {
      apiSecret: this.apiSecret,
      guildId: message.guildId,
      channelIds: [message.channelId, parentId].filter(Boolean),
    })) as DownloadRoute[];

    const route = selectRoute(routes, message.channelId, parentId);
    if (!route) {
      logger.info('Liened Downloads ignored message because no route matched the channel', {
        feature: 'Liened Downloads',
        guildId: message.guildId,
        channelId: message.channelId,
        parentId,
        messageId: message.id,
        attachments: describeAttachments(message),
      });
      return;
    }

    try {
      const mode = await this.isForumRouteMessage(message, route) ? 'reply' : 'replace';
      await this.secureMessage(message, route, mode);
    } catch (err) {
      logger.error('Liened Downloads capture failed', {
        feature: 'Liened Downloads',
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async collectBackfillTargets(route: DownloadRoute): Promise<Message[]> {
    const channel = await this.client.channels.fetch(route.sourceChannelId);
    if (!channel) {
      throw new Error(`Source channel ${route.sourceChannelId} is not accessible`);
    }

    const messages: Message[] = [];

    if ('type' in channel && channel.type === ChannelType.GuildForum) {
      const forum = channel as ForumChannel;
      const activeThreads = await forum.threads.fetchActive();
      const archivedThreads = await forum.threads.fetchArchived({ fetchAll: true });
      const threadMap = new Collection<string, ThreadChannel>();
      for (const thread of activeThreads.threads.values()) threadMap.set(thread.id, thread);
      for (const thread of archivedThreads.threads.values()) threadMap.set(thread.id, thread);

      for (const thread of threadMap.values()) {
        const starterMessage = await thread.fetchStarterMessage().catch(() => null);
        if (starterMessage) messages.push(starterMessage);
        messages.push(...await iterateMessages(thread));
      }
      return messages;
    }

    if (!channel.isTextBased() || !('messages' in channel)) {
      throw new Error(`Source channel ${route.sourceChannelId} is not text-based`);
    }

    messages.push(...await iterateMessages(channel as TextBasedChannel));

    if ('threads' in channel && channel.threads) {
      const activeThreads = await channel.threads.fetchActive().catch(() => null);
      if (activeThreads) {
        for (const thread of activeThreads.threads.values()) {
          messages.push(...await iterateMessages(thread));
        }
      }
      const archivedThreads = await channel.threads.fetchArchived({ type: 'public', fetchAll: true }).catch(() => null);
      if (archivedThreads) {
        for (const thread of archivedThreads.threads.values()) {
          messages.push(...await iterateMessages(thread));
        }
      }
    }

    return messages;
  }

  async backfillRoute(route: DownloadRoute): Promise<BackfillStats> {
    const stats: BackfillStats = {
      scannedMessages: 0,
      securedMessages: 0,
      skippedMessages: 0,
      failedMessages: 0,
      manualCleanupMessages: [],
    };

    const targets = await this.collectBackfillTargets(route);
    for (const message of targets) {
      stats.scannedMessages += 1;
      try {
        const result = await this.secureMessage(message, route, 'reply');
        if (result === 'secured') {
          stats.securedMessages += 1;
          stats.manualCleanupMessages.push({
            sourceMessageId: message.id,
            sourceMessageUrl: message.url,
          });
        } else {
          stats.skippedMessages += 1;
        }
      } catch (error) {
        stats.failedMessages += 1;
        logger.warn('Liened Downloads backfill failed for message', {
          routeId: route._id,
          guildId: route.guildId,
          channelId: message.channelId,
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return stats;
  }

  async autofixRoute(route: DownloadRoute): Promise<{
    fixedMessages: number;
    skippedMessages: number;
    failedMessages: number;
  }> {
    const artifacts = (await this.convex.query('downloads:listActiveArtifactsByRoute' as any, {
      apiSecret: this.apiSecret,
      routeId: route._id,
    })) as DownloadArtifact[];

    const stats = {
      fixedMessages: 0,
      skippedMessages: 0,
      failedMessages: 0,
    };

    for (const artifact of artifacts) {
      if (artifact.sourceDeliveryMode !== 'reply') {
        stats.skippedMessages += 1;
        continue;
      }

      try {
        const result = await this.autofixArtifact(artifact, route);
        if (result === 'skipped') {
          stats.skippedMessages += 1;
          continue;
        }
        stats.fixedMessages += 1;
      } catch (error) {
        stats.failedMessages += 1;
        logger.warn('Liened Downloads autofix failed for message', {
          routeId: route._id,
          guildId: route.guildId,
          sourceChannelId: artifact.sourceChannelId,
          sourceMessageId: artifact.sourceMessageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return stats;
  }

  private async autofixArtifact(
    artifact: DownloadArtifact,
    route: DownloadRoute,
  ): Promise<'fixed' | 'skipped'> {
    const sourceChannel = await this.client.channels.fetch(artifact.sourceChannelId);
    if (!sourceChannel || !sourceChannel.isTextBased() || !('messages' in sourceChannel)) {
      throw new Error(`Source channel ${artifact.sourceChannelId} is not readable`);
    }

    const sourceMessage = await sourceChannel.messages.fetch(artifact.sourceMessageId).catch(() => null);
    if (!sourceMessage) {
      return 'skipped';
    }

    const matchedFiles = getMatchingFiles(sourceMessage, route);
    if (matchedFiles.length === 0) {
      if (artifact.sourceRelayMessageId) {
        await sourceChannel.messages.delete(artifact.sourceRelayMessageId).catch(() => null);
      }
      return 'skipped';
    }

    const restoreArchivedState = await maybeUnarchiveThread(sourceMessage.channel);
    let webhookMessage: Message | null = null;
    try {
      webhookMessage = await relaySecureMessage(this.client, sourceMessage, route, artifact._id, matchedFiles);
      if (!webhookMessage) {
        throw new Error('Webhook replacement message could not be created');
      }
    } finally {
      if (restoreArchivedState) {
        await restoreArchivedState();
      }
    }

    await sourceMessage.delete();
    if (artifact.sourceRelayMessageId) {
      await sourceChannel.messages.delete(artifact.sourceRelayMessageId).catch(() => null);
    }

    await this.convex.mutation('downloads:updateArtifactSourceRelay' as any, {
      apiSecret: this.apiSecret,
      artifactId: artifact._id,
      sourceRelayMessageId: webhookMessage.id,
      sourceDeliveryMode: 'webhook',
    });

    return 'fixed';
  }

  private canUseAutofix(interaction: ButtonInteraction): boolean {
    if (!interaction.inGuild()) return false;
    return interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageMessages) ?? false;
  }

  async handleAutofixPrompt(interaction: ButtonInteraction, artifactId: string): Promise<void> {
    if (!this.canUseAutofix(interaction)) {
      await interaction.reply({
        content: `${E.X_} You need **Manage Messages** to use Autofix.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const artifact = (await this.convex.query('downloads:getArtifactForDelivery' as any, {
      apiSecret: this.apiSecret,
      artifactId,
    })) as DownloadArtifact | null;

    if (!artifact || artifact.status !== 'active' || artifact.sourceDeliveryMode !== 'reply') {
      await interaction.reply({
        content: `${E.X_} This message can’t be autofixed right now.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content:
        `${E.Wrench} Autofix replaces the original message with the protected version.\n` +
        `The original post is deleted.\n\n` +
        `${E.X_} This breaks image previews in forum posts.`,
      components: [buildSingleAutofixConfirmRow(artifactId)],
      flags: MessageFlags.Ephemeral,
    });
  }

  async handleAutofixRun(interaction: ButtonInteraction, artifactId: string): Promise<void> {
    if (!this.canUseAutofix(interaction)) {
      await interaction.reply({
        content: `${E.X_} You need **Manage Messages** to use Autofix.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const artifact = (await this.convex.query('downloads:getArtifactForDelivery' as any, {
      apiSecret: this.apiSecret,
      artifactId,
    })) as DownloadArtifact | null;

    if (!artifact || artifact.status !== 'active') {
      await interaction.editReply({
        content: `${E.X_} This message is no longer available for Autofix.`,
        components: [],
      });
      return;
    }

    const route = (await this.convex.query('downloads:getRouteById' as any, {
      apiSecret: this.apiSecret,
      routeId: artifact.routeId,
    })) as DownloadRoute | null;

    if (!route) {
      await interaction.editReply({
        content: `${E.X_} This route is no longer available.`,
        components: [],
      });
      return;
    }

    try {
      const result = await this.autofixArtifact(artifact, route);
      await interaction.editReply({
        content: result === 'fixed'
          ? `${E.Checkmark} Autofix replaced the message.`
          : `${E.Home} Nothing changed. The source message is no longer available.`,
        components: [],
      });
    } catch (error) {
      logger.warn('Liened Downloads single-message autofix failed', {
        artifactId,
        routeId: route._id,
        error: error instanceof Error ? error.message : String(error),
      });
      await interaction.editReply({
        content: `${E.X_} Couldn’t replace this message right now. Try again in a moment.`,
        components: [],
      });
    }
  }

  async handleAutofixCancel(interaction: ButtonInteraction): Promise<void> {
    await interaction.reply({
      content: `${E.Home} Autofix canceled.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  async handleDownloadButton(interaction: ButtonInteraction, artifactId: string): Promise<void> {
    const artifact = (await this.convex.query('downloads:getArtifactForDelivery' as any, {
      apiSecret: this.apiSecret,
      artifactId,
    })) as DownloadArtifact | null;

    if (!artifact || artifact.status !== 'active') {
      await interaction.reply({
        content: `${E.X_} This download is no longer available.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.inGuild() || interaction.guildId !== artifact.guildId) {
      await interaction.reply({
        content: `${E.X_} Open this download in the server where it was posted.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const member = await interaction.guild!.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      await interaction.reply({
        content: `${E.X_} Your server membership couldn’t be verified right now. Try again.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const hasAccess =
      artifact.roleLogic === 'all'
        ? artifact.requiredRoleIds.every((roleId) => member.roles.cache.has(roleId))
        : artifact.requiredRoleIds.some((roleId) => member.roles.cache.has(roleId));

    if (!hasAccess) {
      await interaction.reply({
        content: `${E.Key} You don’t have access to this download yet.\n${formatRoleRequirement(artifact)}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      embeds: [buildAllowedDownloadEmbed(artifact)],
      flags: MessageFlags.Ephemeral,
    });
  }
}

export function isLienedDownloadButton(customId: string): boolean {
  return customId.startsWith(DOWNLOAD_BUTTON_PREFIX);
}

export function isLienedAutofixButton(customId: string): boolean {
  return customId.startsWith(AUTOFIX_PROMPT_BUTTON_PREFIX)
    || customId.startsWith(AUTOFIX_RUN_BUTTON_PREFIX)
    || customId.startsWith(AUTOFIX_CANCEL_BUTTON_PREFIX);
}

export function getLienedDownloadsInvitePermissions(): bigint {
  return new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.SendMessagesInThreads,
    PermissionsBitField.Flags.CreatePublicThreads,
    PermissionsBitField.Flags.EmbedLinks,
    PermissionsBitField.Flags.AttachFiles,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.ManageWebhooks,
    PermissionsBitField.Flags.ManageRoles,
    PermissionsBitField.Flags.ManageThreads,
  ]).bitfield;
}
