/**
 * /creator-admin stats - Verification statistics with navigation buttons
 *
 * Single command shows overview. Navigation buttons open sub-views.
 * Uses custom Discord icons (E.*, Emoji.*) and CDN thumbnails.
 */

import type { ConvexHttpClient } from 'convex/browser';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  UserSelectMenuInteraction,
} from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  UserSelectMenuBuilder,
} from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import { E, Emoji, EmojiIds, getEmojiCdnUrl } from '../lib/emojis';

const USERS_PAGE_SIZE = 25;
const STATS_SESSION_TTL_MS = 10 * 60 * 1000;

interface StatsUsersSession {
  cursorStack: (string | undefined)[];
  pageIndex: number;
  totalCount: number;
  expiresAt: number;
}

const statsUsersSessions = new Map<string, StatsUsersSession>();

function getStatsSessionKey(userId: string, authUserId: string, guildId: string): string {
  return `${userId}:${authUserId}:${guildId}`;
}

function cleanExpiredStatsSessions(): void {
  const now = Date.now();
  for (const [key, session] of statsUsersSessions.entries()) {
    if (now > session.expiresAt) statsUsersSessions.delete(key);
  }
}

function buildOverviewButtons(
  authUserId: string,
  guildId: string
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`creator_stats:view_users:${authUserId}:${guildId}`)
      .setLabel('View Users')
      .setEmoji(Emoji.Library)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`creator_stats:view_products:${authUserId}:${guildId}`)
      .setLabel('View Products')
      .setEmoji(Emoji.Bag)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`creator_stats:check_user:${authUserId}:${guildId}`)
      .setLabel('Check a User')
      .setEmoji(Emoji.PersonKey)
      .setStyle(ButtonStyle.Secondary)
  );
}

/** /creator-admin stats - shows overview with navigation buttons */
export async function handleStats(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { authUserId: string; guildId: string }
): Promise<void> {
  if (!ctx.guildId) {
    await interaction.reply({
      content: 'This command must be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rules = await convex.query(api.role_rules.getByGuild, {
    apiSecret,
    authUserId: ctx.authUserId,
    guildId: ctx.guildId,
  });
  const stats = await convex.query(api.entitlements.getStatsOverviewExtended, {
    apiSecret,
    authUserId: ctx.authUserId,
  });

  const embed = new EmbedBuilder()
    .setTitle(`${E.Library} Verification Stats`)
    .setColor(0x5865f2)
    .setThumbnail(getEmojiCdnUrl(EmojiIds.Library))
    .setDescription(
      'Unique verified users, product-role mappings, and new verifications in the last 24h, 7d, and 30d.'
    )
    .addFields(
      { name: 'Verified Users', value: String(stats.totalVerified), inline: true },
      { name: 'Products Mapped', value: String(rules.length), inline: true },
      { name: 'Verified (24h)', value: String(stats.recent24h), inline: true },
      { name: 'Verified (7d)', value: String(stats.recent7d), inline: true },
      { name: 'Verified (30d)', value: String(stats.recent30d), inline: true }
    )
    .setTimestamp()
    .setFooter({ text: 'Use the buttons below to explore' });

  const row = buildOverviewButtons(ctx.authUserId, ctx.guildId);
  await interaction.editReply({ embeds: [embed], components: [row] });
}

/** Button: View Users - shows paginated verified users list */
export async function handleStatsViewUsersButton(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  authUserId: string,
  guildId: string
): Promise<void> {
  await interaction.deferUpdate();

  cleanExpiredStatsSessions();
  const sessionKey = getStatsSessionKey(interaction.user.id, authUserId, guildId);
  statsUsersSessions.set(sessionKey, {
    cursorStack: [undefined],
    pageIndex: 0,
    totalCount: 0,
    expiresAt: Date.now() + STATS_SESSION_TTL_MS,
  });

  const { users, nextCursor, totalCount } = await convex.query(
    api.entitlements.getVerifiedUsersPaginated,
    {
      apiSecret,
      authUserId,
      limit: USERS_PAGE_SIZE,
    }
  );

  statsUsersSessions.set(sessionKey, {
    cursorStack: nextCursor != null ? [undefined, nextCursor] : [undefined],
    pageIndex: 0,
    totalCount,
    expiresAt: Date.now() + STATS_SESSION_TTL_MS,
  });

  if (!users.length) {
    const embed = new EmbedBuilder()
      .setTitle(`${E.PersonKey} Verified Users`)
      .setColor(0x5865f2)
      .setThumbnail(getEmojiCdnUrl(EmojiIds.PersonKey))
      .setDescription('No verified users yet.')
      .setFooter({ text: 'Use the button below to return' });

    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`creator_stats:back:${authUserId}:${guildId}`)
        .setLabel('Back to Overview')
        .setEmoji(Emoji.Home)
        .setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [backRow] });
    return;
  }

  const lines = users.map(
    (u: { discordUserId: string; productCount: number }) =>
      `• <@${u.discordUserId}> - ${u.productCount} product(s)`
  );

  const embed = new EmbedBuilder()
    .setTitle(`${E.PersonKey} Verified Users`)
    .setColor(0x5865f2)
    .setThumbnail(getEmojiCdnUrl(EmojiIds.PersonKey))
    .setDescription(lines.join('\n'))
    .setFooter({
      text: `Page 1 • Showing ${users.length} of ${totalCount} users`,
    });

  const row = buildViewUsersPaginationRow(authUserId, guildId, 0, totalCount, nextCursor != null);
  await interaction.editReply({ embeds: [embed], components: [row] });
}

/** Button: View Users pagination (next/prev) */
export async function handleStatsViewUsersPageButton(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  authUserId: string,
  guildId: string,
  direction: 'next' | 'prev'
): Promise<void> {
  await interaction.deferUpdate();

  cleanExpiredStatsSessions();
  const sessionKey = getStatsSessionKey(interaction.user.id, authUserId, guildId);
  const session = statsUsersSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.editReply({
      content: `${E.Timer} Session expired. Run \`/creator-admin stats\` again.`,
      components: [],
    });
    return;
  }

  const newPageIndex = direction === 'next' ? session.pageIndex + 1 : session.pageIndex - 1;
  const cursor = session.cursorStack[newPageIndex];

  const { users, nextCursor, totalCount } = await convex.query(
    api.entitlements.getVerifiedUsersPaginated,
    {
      apiSecret,
      authUserId,
      limit: USERS_PAGE_SIZE,
      cursor: cursor ?? undefined,
    }
  );

  const newCursorStack = [...session.cursorStack];
  if (direction === 'next' && nextCursor && newPageIndex + 1 >= newCursorStack.length) {
    newCursorStack.push(nextCursor);
  }

  statsUsersSessions.set(sessionKey, {
    cursorStack: newCursorStack,
    pageIndex: newPageIndex,
    totalCount,
    expiresAt: Date.now() + STATS_SESSION_TTL_MS,
  });

  const lines = users.map(
    (u: { discordUserId: string; productCount: number }) =>
      `• <@${u.discordUserId}> - ${u.productCount} product(s)`
  );

  const start = newPageIndex * USERS_PAGE_SIZE + 1;
  const end = Math.min(start + users.length - 1, totalCount);

  const embed = new EmbedBuilder()
    .setTitle(`${E.PersonKey} Verified Users`)
    .setColor(0x5865f2)
    .setThumbnail(getEmojiCdnUrl(EmojiIds.PersonKey))
    .setDescription(lines.join('\n'))
    .setFooter({
      text: `Page ${newPageIndex + 1} • Showing ${start}-${end} of ${totalCount} users`,
    });

  const row = buildViewUsersPaginationRow(
    authUserId,
    guildId,
    newPageIndex,
    totalCount,
    nextCursor != null
  );
  await interaction.editReply({ embeds: [embed], components: [row] });
}

function buildViewUsersPaginationRow(
  authUserId: string,
  guildId: string,
  pageIndex: number,
  _totalCount: number,
  hasNext: boolean
): ActionRowBuilder<ButtonBuilder> {
  const buttons: ButtonBuilder[] = [];

  if (pageIndex > 0) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`creator_stats:view_users_page:${authUserId}:${guildId}:prev`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(`creator_stats:back:${authUserId}:${guildId}`)
      .setLabel('Back to Overview')
      .setEmoji(Emoji.Home)
      .setStyle(ButtonStyle.Secondary)
  );

  if (hasNext) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`creator_stats:view_users_page:${authUserId}:${guildId}:next`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

/** Button: Back to Overview */
export async function handleStatsBackButton(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  authUserId: string,
  guildId: string
): Promise<void> {
  await interaction.deferUpdate();

  cleanExpiredStatsSessions();
  const sessionKey = getStatsSessionKey(interaction.user.id, authUserId, guildId);
  statsUsersSessions.delete(sessionKey);

  const rules = await convex.query(api.role_rules.getByGuild, {
    apiSecret,
    authUserId,
    guildId,
  });
  const stats = await convex.query(api.entitlements.getStatsOverviewExtended, {
    apiSecret,
    authUserId,
  });

  const embed = new EmbedBuilder()
    .setTitle(`${E.Library} Verification Stats`)
    .setColor(0x5865f2)
    .setThumbnail(getEmojiCdnUrl(EmojiIds.Library))
    .setDescription(
      'Unique verified users, product-role mappings, and new verifications in the last 24h, 7d, and 30d.'
    )
    .addFields(
      { name: 'Verified Users', value: String(stats.totalVerified), inline: true },
      { name: 'Products Mapped', value: String(rules.length), inline: true },
      { name: 'Verified (24h)', value: String(stats.recent24h), inline: true },
      { name: 'Verified (7d)', value: String(stats.recent7d), inline: true },
      { name: 'Verified (30d)', value: String(stats.recent30d), inline: true }
    )
    .setTimestamp()
    .setFooter({ text: 'Use the buttons below to explore' });

  const row = buildOverviewButtons(authUserId, guildId);
  await interaction.editReply({ embeds: [embed], components: [row] });
}

/** Button: View Products - shows product verification counts with display names */
export async function handleStatsViewProductsButton(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  authUserId: string,
  guildId: string
): Promise<void> {
  await interaction.deferUpdate();

  const [productStats, productNames] = await Promise.all([
    convex.query(api.entitlements.getProductStats, {
      apiSecret,
      authUserId,
    }),
    convex.query(api.role_rules.getByGuildWithProductNames, {
      apiSecret,
      authUserId,
      guildId,
    }),
  ]);

  const nameMap = new Map(
    (productNames as { productId: string; displayName: string | null }[]).map((p) => [
      p.productId,
      p.displayName ?? p.productId.slice(0, 12) + (p.productId.length > 12 ? '…' : ''),
    ])
  );

  if (!productStats.length) {
    const embed = new EmbedBuilder()
      .setTitle(`${E.Bag} Product Verification Counts`)
      .setColor(0x5865f2)
      .setThumbnail(getEmojiCdnUrl(EmojiIds.Bag))
      .setDescription('No product verification data yet.')
      .setFooter({ text: 'Use the button below to return' });

    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`creator_stats:back:${authUserId}:${guildId}`)
        .setLabel('Back to Overview')
        .setEmoji(Emoji.Home)
        .setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [backRow] });
    return;
  }

  const sorted = (productStats as { productId: string; verifiedCount: number }[])
    .sort((a, b) => b.verifiedCount - a.verifiedCount)
    .map((p) => {
      const name =
        nameMap.get(p.productId) ?? p.productId.slice(0, 12) + (p.productId.length > 12 ? '…' : '');
      return `• **${name}** - ${p.verifiedCount} verified`;
    });

  const embed = new EmbedBuilder()
    .setTitle(`${E.Bag} Product Verification Counts`)
    .setColor(0x5865f2)
    .setThumbnail(getEmojiCdnUrl(EmojiIds.Bag))
    .setDescription(sorted.join('\n'))
    .setFooter({ text: 'Top products by verification count' });

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`creator_stats:back:${authUserId}:${guildId}`)
      .setLabel('Back to Overview')
      .setEmoji(Emoji.Home)
      .setStyle(ButtonStyle.Secondary)
  );
  await interaction.editReply({ embeds: [embed], components: [backRow] });
}

/** Button: Check a User - shows user select menu */
export async function handleStatsCheckUserButton(
  interaction: ButtonInteraction,
  authUserId: string,
  guildId: string
): Promise<void> {
  await interaction.deferUpdate();

  const userSelect = new UserSelectMenuBuilder()
    .setCustomId(`creator_stats:check_user_select:${authUserId}:${guildId}`)
    .setPlaceholder('Select a user to check verification status...')
    .setMinValues(1)
    .setMaxValues(1);

  const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);

  const embed = new EmbedBuilder()
    .setTitle(`${E.PersonKey} Check User Verification`)
    .setColor(0x5865f2)
    .setThumbnail(getEmojiCdnUrl(EmojiIds.PersonKey))
    .setDescription('Select a user from the dropdown to view their verification status.')
    .setFooter({ text: 'Use the button below to return' });

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`creator_stats:back:${authUserId}:${guildId}`)
      .setLabel('Back to Overview')
      .setEmoji(Emoji.Home)
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    embeds: [embed],
    components: [row, backRow],
  });
}

/** User select: Check user verification status */
export async function handleStatsCheckUserSelect(
  interaction: UserSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  authUserId: string,
  guildId: string
): Promise<void> {
  const selectedUser = interaction.users.first();
  if (!selectedUser) {
    await interaction.reply({ content: 'No user selected.', flags: MessageFlags.Ephemeral });
    return;
  }

  const discordUserId = selectedUser.id;
  await interaction.deferUpdate();

  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId, {
    apiSecret,
    discordUserId,
  });

  if (!subjectResult.found) {
    await interaction.editReply({
      content: `No account found for <@${discordUserId}>. They may not have verified yet.`,
      embeds: [],
      components: [],
    });
    return;
  }

  const entitlements = (await convex.query(api.entitlements.getEntitlementsBySubject, {
    apiSecret,
    authUserId,
    subjectId: subjectResult.subject._id,
    includeInactive: false,
  })) as { productId: string }[];

  const productIds = [...new Set(entitlements.map((e) => e.productId))];
  const status = productIds.length ? `Verified ${E.Checkmark}` : 'No active products';

  let productDisplay = 'None';
  if (productIds.length) {
    const productNames = await convex.query(api.role_rules.getByGuildWithProductNames, {
      apiSecret,
      authUserId,
      guildId,
    });
    const nameMap = new Map(
      (productNames as { productId: string; displayName: string | null }[]).map((p) => [
        p.productId,
        p.displayName ?? p.productId,
      ])
    );
    productDisplay = productIds
      .map((id) => nameMap.get(id) ?? id)
      .map((n) => `\`${n}\``)
      .join(', ');
  }

  const embed = new EmbedBuilder()
    .setTitle(`Verification: <@${discordUserId}>`)
    .setColor(0x5865f2)
    .setThumbnail(getEmojiCdnUrl(EmojiIds.PersonKey))
    .addFields(
      { name: 'Status', value: status, inline: false },
      { name: 'Products', value: productDisplay, inline: false }
    );

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`creator_stats:back:${authUserId}:${guildId}`)
      .setLabel('Back to Overview')
      .setEmoji(Emoji.Home)
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ embeds: [embed], components: [backRow] });
}
