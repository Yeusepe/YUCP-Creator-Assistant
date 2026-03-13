/**
 * /creator - State-aware verification status panel (user command)
 * /creator-admin spawn-verify - Spawn verify button in channel
 * Verify button interaction - shows same status panel
 */

import { randomBytes } from 'node:crypto';
import { PROVIDER_META, providerLabel } from '@yucp/providers';
import { createLogger, formatVerificationSupportMessage } from '@yucp/shared';
import type { ConvexHttpClient } from 'convex/browser';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { getApiUrls } from '../lib/apiUrls';
import { E, Emoji } from '../lib/emojis';
import { completeLicenseVerification, disconnectVerification } from '../lib/internalRpc';
import { track } from '../lib/posthog';
import { sanitizeUserFacingErrorMessage } from '../lib/userFacingErrors';
import { buildBotVerificationErrorMessage } from '../lib/verificationSupport';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const VERIFY_PREFIX = 'creator_verify:';

/** Default embed for spawn-verify: explains verification (scannable, benefit-first, plain language). */
const DEFAULT_SPAWN_TITLE = `${E.Assistant} Verify your purchase`;
const DEFAULT_SPAWN_DESCRIPTION = [
  `${E.Touch} Click the button below to open the verification panel.`,
  '',
  `${E.Link} **Sign in** - Connect ${E.Gumorad} Gumroad or ${E.Discord} Discord. We recognize your purchases and grant your role automatically.`,
  '',
  `${E.KeyCloud} **One license key, then you’re set** - Using ${E.Jinxxy} Jinxxy or a ${E.Gumorad} Gumroad license? Enter one key once. We link your account and sync all past and future purchases so you only verify once.`,
  '',
  'Connections are secure and used only for verification.',
].join('\n');
const DEFAULT_SPAWN_BUTTON_TEXT = 'Verify';
const DEFAULT_SPAWN_COLOR = 0x5865f2; // Discord Blurple

// Semantic colors
const COLOR_GRAY = 0x4f545c; // Nothing connected
const COLOR_ORANGE = 0xfaa61a; // Connected but no purchases found
const COLOR_GREEN = 0x57f287; // Verified

type VerifyState = 'nothing' | 'connected_no_products' | 'verified';

const VERIFIED_PRODUCTS_DISPLAY_LIMIT = 10;
const VERIFY_PANEL_TTL_MS = 15 * 60 * 1000;

interface ActiveVerifyPanel {
  guildId: string;
  messageId: string;
  panelToken?: string;
  authUserId: string;
  updatedAt: number;
  userId: string;
  webhook: ChatInputCommandInteraction['webhook'];
}

const activeVerifyPanels = new Map<string, ActiveVerifyPanel>();

interface LinkedAccountSummary {
  _id?: string;
  provider: string;
  providerUserId?: string;
  providerUsername?: string;
  status: string;
}

interface VerifyData {
  state: VerifyState;
  linkedAccounts: LinkedAccountSummary[];
  productIds: string[];
  /** Products verified in this server only, with display names, limited for UI */
  guildProductDisplayList: Array<{ displayName: string }>;
  /** Total count of verified products in this server (for "and X more") */
  guildProductCount: number;
  /** Set of provider keys the user has at least one active account for */
  connectedProviders: Set<string>;
}

function getVerifyPanelKey(userId: string, guildId: string): string {
  return `${userId}:${guildId}`;
}

function getActiveVerifyPanel(userId: string, guildId: string): ActiveVerifyPanel | null {
  const key = getVerifyPanelKey(userId, guildId);
  const existing = activeVerifyPanels.get(key);
  if (!existing) return null;
  if (Date.now() - existing.updatedAt > VERIFY_PANEL_TTL_MS) {
    activeVerifyPanels.delete(key);
    return null;
  }
  return existing;
}

function clearActiveVerifyPanel(userId: string, guildId: string): void {
  activeVerifyPanels.delete(getVerifyPanelKey(userId, guildId));
}

function createVerifyPanelToken(): string {
  return randomBytes(24).toString('hex');
}

export function rememberActiveVerifyPanel(
  interaction: ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction,
  authUserId: string,
  guildId: string,
  messageId: string,
  options?: {
    panelToken?: string;
  }
): void {
  const key = getVerifyPanelKey(interaction.user.id, guildId);
  const existing = activeVerifyPanels.get(key);
  activeVerifyPanels.set(key, {
    guildId,
    messageId,
    panelToken: options?.panelToken ?? existing?.panelToken,
    authUserId,
    updatedAt: Date.now(),
    userId: interaction.user.id,
    webhook: interaction.webhook,
  });
}

interface VerifyStatusReply {
  components: [ContainerBuilder];
  flags: MessageFlags.IsComponentsV2;
}

async function tryEditActiveVerifyPanel(
  userId: string,
  guildId: string,
  payload: VerifyStatusReply
): Promise<boolean> {
  const existing = getActiveVerifyPanel(userId, guildId);
  if (!existing) return false;

  try {
    await existing.webhook.editMessage(existing.messageId, payload);
    existing.updatedAt = Date.now();
    return true;
  } catch {
    try {
      await existing.webhook.deleteMessage(existing.messageId);
    } catch {
      // Best-effort cleanup only.
    }
    clearActiveVerifyPanel(userId, guildId);
    return false;
  }
}

async function bindVerifyPanelToken(
  apiBaseUrl: string | undefined,
  apiSecret: string,
  interaction: ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction,
  params: {
    discordUserId: string;
    guildId: string;
    messageId: string;
    panelToken: string;
    authUserId: string;
  }
): Promise<void> {
  const applicationId = interaction.applicationId?.trim();
  const interactionToken = interaction.token?.trim();
  const messageId = params.messageId.trim();
  const panelToken = params.panelToken.trim();
  const missingFields = [
    !applicationId ? 'applicationId' : null,
    !interactionToken ? 'interactionToken' : null,
    !messageId ? 'messageId' : null,
    !panelToken ? 'panelToken' : null,
  ].filter((value): value is string => value !== null);

  if (missingFields.length > 0) {
    logger.info('Skipped verify panel token bind because interaction context is incomplete', {
      guildId: params.guildId,
      missingFields,
      userId: params.discordUserId,
    });
    return;
  }

  const apiForFetch = getApiUrls().apiInternal ?? apiBaseUrl;
  if (!apiForFetch) return;

  try {
    const res = await fetch(`${apiForFetch}/api/verification/panel/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiSecret,
        applicationId,
        discordUserId: params.discordUserId,
        guildId: params.guildId,
        interactionToken,
        messageId,
        panelToken,
        authUserId: params.authUserId,
      }),
    });
    if (!res.ok) {
      const result = (await res.json().catch(() => ({}))) as {
        error?: string;
        supportCode?: string;
      };
      const metadata = {
        error: result.error,
        guildId: params.guildId,
        status: res.status,
        supportCode: result.supportCode,
        userId: params.discordUserId,
      };
      if (result.supportCode) {
        logger.warn('Failed to bind verify panel token', metadata);
      } else {
        logger.info('Verify panel token was not bound', metadata);
      }
    }
  } catch (err) {
    logger.warn('Failed to bind verify panel token', {
      error: err instanceof Error ? err.message : String(err),
      guildId: params.guildId,
      userId: params.discordUserId,
    });
  }
}

async function fetchVerifyData(
  userId: string,
  authUserId: string,
  guildId: string,
  convex: ConvexHttpClient,
  apiSecret: string
): Promise<VerifyData> {
  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId, {
    apiSecret,
    discordUserId: userId,
  });

  let linkedAccounts: LinkedAccountSummary[] = [];
  let productIds: string[] = [];
  let guildProductDisplayList: Array<{ displayName: string }> = [];
  let inGuildCount = 0;

  if (subjectResult.found) {
    try {
      await convex.mutation(api.providerConnections.cleanupDuplicateAccountsForSubject, {
        apiSecret,
        subjectId: subjectResult.subject._id,
        authUserId,
      });
    } catch (error) {
      logger.warn('Failed to clean up duplicate linked accounts before rendering verify panel', {
        discordUserId: userId,
        error: error instanceof Error ? error.message : String(error),
        subjectId: subjectResult.subject._id,
        authUserId,
      });
    }

    const [accountsResult, entitlements, guildProducts] = await Promise.all([
      convex.query(api.subjects.getSubjectWithAccounts, {
        apiSecret,
        subjectId: subjectResult.subject._id,
        authUserId,
      }),
      convex.query(api.entitlements.getEntitlementsBySubject, {
        apiSecret,
        authUserId,
        subjectId: subjectResult.subject._id,
        includeInactive: false,
      }),
      convex.query(api.role_rules.getByGuildWithProductNames, {
        apiSecret,
        authUserId,
        guildId,
      }),
    ]);

    if (accountsResult.found) {
      linkedAccounts = accountsResult.externalAccounts;
    }

    const entitlementProductIds = [
      ...new Set((entitlements as Array<{ productId: string }>).map((e) => e.productId)),
    ];
    productIds = entitlementProductIds;

    const guildProductMap = new Map(
      (guildProducts as Array<{ productId: string; displayName: string | null }>).map((p) => [
        p.productId,
        p.displayName ?? p.productId,
      ])
    );
    const inGuild = entitlementProductIds.filter((id) => guildProductMap.has(id));
    inGuildCount = inGuild.length;
    guildProductDisplayList = inGuild
      .slice(0, VERIFIED_PRODUCTS_DISPLAY_LIMIT)
      .map((id) => ({ displayName: (guildProductMap.get(id) ?? id) as string }));
  }

  const connectedProviders = new Set(
    linkedAccounts.filter((a) => a.status === 'active').map((a) => a.provider)
  );
  const activeAccounts = linkedAccounts.filter((a) => a.status === 'active');

  let state: VerifyState;
  if (activeAccounts.length === 0) {
    state = 'nothing';
  } else if (inGuildCount === 0) {
    state = 'connected_no_products';
  } else {
    state = 'verified';
  }

  return {
    state,
    linkedAccounts,
    productIds,
    guildProductDisplayList,
    guildProductCount: inGuildCount,
    connectedProviders,
  };
}

/** Get user-friendly banner message from failed role_sync jobs (role hierarchy, permissions, etc.). */
async function getRoleSyncBanner(
  authUserId: string,
  guildId: string,
  discordUserId: string,
  convex: ConvexHttpClient,
  apiSecret: string
): Promise<string | undefined> {
  const jobs = await convex.query(api.outbox_jobs.getFailedRoleSyncForUser, {
    apiSecret,
    authUserId,
    discordUserId,
    guildId,
  });
  const err = jobs[0]?.lastError;
  if (!err) return undefined;
  if (err.includes('Role hierarchy') || err.toLowerCase().includes('role hierarchy')) {
    return `${E.Wrench} **Role setup needed** - The verified role is above the bot's role. Ask a server admin to move the bot's role above the verified role in Server Settings → Roles.`;
  }
  if (
    err.includes('50013') ||
    err.includes('Missing Permissions') ||
    err.includes('Manage Roles')
  ) {
    return `${E.Wrench} **Permissions needed** - The bot needs Manage Roles. Re-invite with the updated link in the Creator Portal.`;
  }
  return `${E.Wrench} Could not assign role: ${err.slice(0, 120)}${err.length > 120 ? '…' : ''}`;
}

/** Build context-aware prompt based on which verification methods are available. */
function getVerifyPrompt(enabledSet: Set<string>): string {
  const methods: string[] = [];
  for (const provider of enabledSet) {
    if (provider === 'discord') {
      methods.push(`${E.Discord} another server`);
      continue;
    }
    const meta = PROVIDER_META[provider as keyof typeof PROVIDER_META];
    if (meta) {
      const emoji = meta.emojiKey ? (E[meta.emojiKey as keyof typeof E] ?? '') : '';
      methods.push(`${emoji} ${meta.label}`);
    }
  }
  if (methods.length === 0) return '';
  if (methods.length === 1) {
    if (enabledSet.size === 1 && enabledSet.has('discord')) {
      return `${E.Touch} Verify your role from another server:`;
    }
    const nonDiscord = [...enabledSet].find((p) => p !== 'discord');
    const meta = nonDiscord ? PROVIDER_META[nonDiscord as keyof typeof PROVIDER_META] : undefined;
    const name = meta?.label ?? nonDiscord ?? 'store';
    return `${E.Touch} Choose how to verify your ${name} purchase:`;
  }
  return `${E.Touch} Choose how to verify your purchase:`;
}

/** Build context-aware message for connected_no_products state. */
function getConnectedNoProductsPrompt(enabledSet: Set<string>): string {
  const methods: string[] = [];
  for (const provider of enabledSet) {
    if (provider === 'discord') {
      methods.push('another server');
      continue;
    }
    const meta = PROVIDER_META[provider as keyof typeof PROVIDER_META];
    if (meta) methods.push(meta.label);
  }
  if (methods.length === 0) return '';
  const hint =
    methods.length === 1 ? `try connecting via ${methods[0]}` : 'try another verification method';
  return `Your account is connected but we didn't find any matching purchases.\nMake sure you're using the account you bought with, or ${hint}:`;
}

function getUniqueActiveEnabledProviders(
  linkedAccounts: LinkedAccountSummary[],
  enabledSet: Set<string>
): string[] {
  const seen = new Set<string>();
  const orderedProviders: string[] = [];
  for (const account of linkedAccounts) {
    if (account.status !== 'active') continue;
    if (!enabledSet.has(account.provider)) continue;
    if (seen.has(account.provider)) continue;
    seen.add(account.provider);
    orderedProviders.push(account.provider);
  }
  return orderedProviders;
}

function getActiveProviderCount(linkedAccounts: LinkedAccountSummary[], provider: string): number {
  return linkedAccounts.filter(
    (account) => account.provider === provider && account.status === 'active'
  ).length;
}

function addButtonRows<T extends ButtonBuilder>(
  container: { addActionRowComponents: (...rows: ActionRowBuilder<ButtonBuilder>[]) => unknown },
  buttons: T[]
): void {
  for (let i = 0; i < buttons.length; i += 5) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + 5))
    );
  }
}

function buildStatusContainer(
  data: VerifyData,
  authUserId: string,
  guildId: string,
  apiBaseUrl: string | undefined,
  enabledSet: Set<string>,
  panelToken?: string,
  userId?: string,
  bannerMessage?: string
): ContainerBuilder {
  const { state, linkedAccounts, guildProductDisplayList, guildProductCount, connectedProviders } =
    data;

  const accentColor =
    state === 'nothing'
      ? COLOR_GRAY
      : state === 'connected_no_products'
        ? COLOR_ORANGE
        : COLOR_GREEN;

  const container = new ContainerBuilder().setAccentColor(accentColor);

  // Optional banner (e.g. success/error) - must use TextDisplay when using MessageFlags.IsComponentsV2
  if (bannerMessage) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(bannerMessage));
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );
  }

  // Title
  if (state === 'verified') {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${E.ClapStars} You're verified!`)
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${E.PersonKey} Your verification status`)
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  // Connected accounts, driven by enabledSet + PROVIDER_META
  const lines: string[] = [];
  const getConnectionLabel = (provider: string, label: string, emoji: string) => {
    const activeCount = getActiveProviderCount(linkedAccounts, provider);
    if (activeCount === 0) return `${emoji} ${label} - Not connected`;
    if (activeCount === 1) return `${emoji} ${label} - ${E.Checkmark} Connected`;
    return `${emoji} ${label} - ${E.Checkmark} ${activeCount} accounts connected`;
  };
  for (const provider of enabledSet) {
    if (provider === 'discord') {
      lines.push(getConnectionLabel('discord', 'Discord (other server)', E.Discord));
      continue;
    }
    const meta = PROVIDER_META[provider as keyof typeof PROVIDER_META];
    if (meta) {
      const emoji = meta.emojiKey ? (E[meta.emojiKey as keyof typeof E] ?? '') : '';
      lines.push(getConnectionLabel(provider, meta.label, emoji));
    }
  }
  if (lines.length > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**Connected Accounts**\n${lines.join('\n')}`)
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  // Verified products (this server only, display names, limited)
  if (guildProductDisplayList.length > 0) {
    const productList = guildProductDisplayList.map((p) => `• ${p.displayName}`).join('\n');
    const moreLine =
      guildProductCount > VERIFIED_PRODUCTS_DISPLAY_LIMIT
        ? `\n_…and ${guildProductCount - VERIFIED_PRODUCTS_DISPLAY_LIMIT} more_`
        : '';
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**Verified Products**\n${productList}${moreLine}`)
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('**Verified Products**\nNone yet')
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  // Build shared redirect URI
  const returnTo = `https://discord.com/channels/${guildId}`;
  const successParams = new URLSearchParams({ returnTo });
  if (panelToken) successParams.set('panelToken', panelToken);
  const redirectUri = apiBaseUrl ? `${apiBaseUrl}/verify-success?${successParams.toString()}` : '';

  /** Build a verification begin URL for a given mode/provider key */
  const buildBeginUrl = (mode: string): string | null => {
    if (!apiBaseUrl) return null;
    const params = new URLSearchParams({ authUserId, mode, redirectUri });
    if (userId) params.set('discordUserId', userId);
    return `${apiBaseUrl}/api/verification/begin?${params.toString()}`;
  };

  /** True if any enabled provider supports license key verification */
  const hasLicenseProviders = [...enabledSet].some(
    (p) => PROVIDER_META[p as keyof typeof PROVIDER_META]?.supportsLicenseVerify
  );

  if (state === 'nothing') {
    const buttons: ButtonBuilder[] = [];

    // OAuth "Connect" buttons for each enabled OAuth provider (not Discord/VRChat, handled separately)
    for (const provider of enabledSet) {
      if (provider === 'discord' || provider === 'vrchat') continue;
      const meta = PROVIDER_META[provider as keyof typeof PROVIDER_META];
      if (!meta?.supportsOAuth) continue;
      const url = buildBeginUrl(provider);
      if (!url) continue;
      const emoji = meta.emojiKey ? Emoji[meta.emojiKey as keyof typeof Emoji] : undefined;
      const btn = new ButtonBuilder()
        .setLabel(`Connect ${meta.label}`)
        .setStyle(ButtonStyle.Link)
        .setURL(url);
      if (emoji) btn.setEmoji(emoji);
      buttons.push(btn);
    }

    // License key button (single button covering all supportsLicenseVerify providers)
    if (hasLicenseProviders) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`${VERIFY_PREFIX}license:${authUserId}`)
          .setLabel('Use License Key')
          .setEmoji(Emoji.KeyCloud)
          .setStyle(ButtonStyle.Secondary)
      );
    }

    // VRChat credential login button
    if (enabledSet.has('vrchat') && apiBaseUrl) {
      const url = buildBeginUrl('vrchat');
      if (url) {
        buttons.push(
          new ButtonBuilder()
            .setLabel('Verify with VRChat')
            .setEmoji(Emoji.VRC)
            .setStyle(ButtonStyle.Link)
            .setURL(url)
        );
      }
    }

    // Discord role button
    if (enabledSet.has('discord')) {
      const url = buildBeginUrl('discord_role');
      if (url) {
        buttons.push(
          new ButtonBuilder()
            .setLabel('Use Another Server')
            .setEmoji(Emoji.Discord)
            .setStyle(ButtonStyle.Link)
            .setURL(url)
        );
      }
    }

    if (buttons.length > 0) {
      const prompt = getVerifyPrompt(enabledSet);
      if (prompt) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(prompt));
      }
      addButtonRows(container, buttons);
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `${E.Wrench} No products have been added to this server for verification. Contact the server admin to add products.`
        )
      );
    }
  } else if (state === 'connected_no_products') {
    const connectedPrompt = getConnectedNoProductsPrompt(enabledSet);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        connectedPrompt ||
          "Your account is connected but we didn't find any matching purchases.\nMake sure you're using the account you bought with, or try another method:"
      )
    );

    const buttons: ButtonBuilder[] = [];

    // OAuth "Connect" buttons for providers the user hasn't connected yet
    for (const provider of enabledSet) {
      if (provider === 'discord' || provider === 'vrchat') continue;
      const meta = PROVIDER_META[provider as keyof typeof PROVIDER_META];
      if (!meta?.supportsOAuth) continue;
      if (connectedProviders.has(provider)) continue; // already connected
      const url = buildBeginUrl(provider);
      if (!url) continue;
      const emoji = meta.emojiKey ? Emoji[meta.emojiKey as keyof typeof Emoji] : undefined;
      const btn = new ButtonBuilder()
        .setLabel(`Connect ${meta.label}`)
        .setStyle(ButtonStyle.Link)
        .setURL(url);
      if (emoji) btn.setEmoji(emoji);
      buttons.push(btn);
    }

    // License key button
    if (hasLicenseProviders) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`${VERIFY_PREFIX}license:${authUserId}`)
          .setLabel('Use License Key')
          .setEmoji(Emoji.Key)
          .setStyle(ButtonStyle.Secondary)
      );
    }

    // VRChat button if not yet connected
    if (enabledSet.has('vrchat') && !connectedProviders.has('vrchat') && apiBaseUrl) {
      const url = buildBeginUrl('vrchat');
      if (url) {
        buttons.push(
          new ButtonBuilder()
            .setLabel('Verify with VRChat')
            .setEmoji(Emoji.VRC)
            .setStyle(ButtonStyle.Link)
            .setURL(url)
        );
      }
    }

    // Discord role button if not yet connected
    if (enabledSet.has('discord') && !connectedProviders.has('discord')) {
      const url = buildBeginUrl('discord_role');
      if (url) {
        buttons.push(
          new ButtonBuilder()
            .setLabel('Use Another Server')
            .setEmoji(Emoji.Discord)
            .setStyle(ButtonStyle.Link)
            .setURL(url)
        );
      }
    }

    if (buttons.length > 0) {
      addButtonRows(container, buttons);
    }

    const disconnectButtons = getUniqueActiveEnabledProviders(linkedAccounts, enabledSet).map(
      (provider) =>
        new ButtonBuilder()
          .setCustomId(`${VERIFY_PREFIX}disconnect:${provider}`)
          .setLabel(`Disconnect ${providerLabel(provider)}`)
          .setEmoji(Emoji.X_)
          .setStyle(ButtonStyle.Danger)
    );
    if (disconnectButtons.length > 0) {
      addButtonRows(container, disconnectButtons);
    }
  } else {
    // Verified state
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${E.Home} You have access to this server. Use the buttons below to manage your connection.`
      )
    );

    const primaryButtons = [
      new ButtonBuilder()
        .setCustomId(`${VERIFY_PREFIX}add_more:${authUserId}`)
        .setLabel('Add another account')
        .setEmoji(Emoji.Refresh)
        .setStyle(ButtonStyle.Secondary),
      ...getUniqueActiveEnabledProviders(linkedAccounts, enabledSet).map((provider) =>
        new ButtonBuilder()
          .setCustomId(`${VERIFY_PREFIX}disconnect:${provider}`)
          .setLabel(`Disconnect ${providerLabel(provider)}`)
          .setEmoji(Emoji.X_)
          .setStyle(ButtonStyle.Danger)
      ),
    ];
    addButtonRows(container, primaryButtons);
  }

  return container;
}

export async function buildVerifyStatusReply(
  userId: string,
  authUserId: string,
  guildId: string,
  convex: ConvexHttpClient,
  apiSecret: string,
  apiBaseUrl: string | undefined,
  options?: {
    bannerMessage?: string;
    panelToken?: string;
    stateOverride?: VerifyState;
  }
): Promise<VerifyStatusReply> {
  const [data, providersResult] = await Promise.all([
    fetchVerifyData(userId, authUserId, guildId, convex, apiSecret),
    convex.query(api.role_rules.getEnabledVerificationProvidersFromProducts, {
      apiSecret,
      authUserId,
      guildId,
    }),
  ]);
  const enabledSet = new Set<string>((providersResult as { providers: string[] }).providers);

  const bannerMessage =
    options?.bannerMessage ??
    (!options?.stateOverride && data.state === 'verified'
      ? await getRoleSyncBanner(authUserId, guildId, userId, convex, apiSecret)
      : undefined);

  const container = buildStatusContainer(
    options?.stateOverride ? { ...data, state: options.stateOverride } : data,
    authUserId,
    guildId,
    apiBaseUrl,
    enabledSet,
    options?.panelToken,
    userId,
    bannerMessage
  );

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  };
}

/** /creator slash command - shows state-aware verification status panel */
export async function handleCreatorCommand(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  apiBaseUrl: string | undefined,
  ctx: { authUserId: string; guildId: string }
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  track(interaction.user.id, 'command_used', {
    command: 'creator',
    guildId: ctx.guildId,
    authUserId: ctx.authUserId,
    userId: interaction.user.id,
  });

  try {
    const panelToken =
      getActiveVerifyPanel(interaction.user.id, ctx.guildId)?.panelToken ??
      createVerifyPanelToken();
    const reply = await buildVerifyStatusReply(
      interaction.user.id,
      ctx.authUserId,
      ctx.guildId,
      convex,
      apiSecret,
      apiBaseUrl,
      { panelToken }
    );

    if (await tryEditActiveVerifyPanel(interaction.user.id, ctx.guildId, reply)) {
      await interaction.deleteReply().catch(() => {});
      return;
    }

    const message = await interaction.editReply(reply);
    rememberActiveVerifyPanel(interaction, ctx.authUserId, ctx.guildId, message.id, {
      panelToken,
    });
    await bindVerifyPanelToken(apiBaseUrl, apiSecret, interaction, {
      discordUserId: interaction.user.id,
      guildId: ctx.guildId,
      messageId: message.id,
      panelToken,
      authUserId: ctx.authUserId,
    });
  } catch (err) {
    await interaction.editReply({
      content: await buildBotVerificationErrorMessage(logger, {
        baseMessage: `${E.X_} An error occurred. Please try again.`,
        discordUserId: interaction.user.id,
        error: err,
        guildId: ctx.guildId,
        stage: 'creator_command_panel',
        authUserId: ctx.authUserId,
      }),
    });
  }
}

/** "Verify" button in channel - shows same state-aware panel */
export async function handleVerifyStartButton(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  apiBaseUrl: string | undefined,
  ctx: { authUserId: string; guildId: string }
): Promise<void> {
  track(interaction.user.id, 'spawn_button_clicked', {
    guildId: ctx.guildId,
    userId: interaction.user.id,
  });

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  try {
    const panelToken = createVerifyPanelToken();
    const reply = await buildVerifyStatusReply(
      interaction.user.id,
      ctx.authUserId,
      ctx.guildId,
      convex,
      apiSecret,
      apiBaseUrl,
      { panelToken }
    );

    const message = await interaction.editReply(reply);
    rememberActiveVerifyPanel(interaction, ctx.authUserId, ctx.guildId, message.id, {
      panelToken,
    });
    await bindVerifyPanelToken(apiBaseUrl, apiSecret, interaction, {
      discordUserId: interaction.user.id,
      guildId: ctx.guildId,
      messageId: message.id,
      panelToken,
      authUserId: ctx.authUserId,
    });
  } catch (err) {
    await interaction.editReply({
      content: await buildBotVerificationErrorMessage(logger, {
        baseMessage: `${E.X_} An error occurred. Please try again.`,
        discordUserId: interaction.user.id,
        error: err,
        guildId: ctx.guildId,
        stage: 'verify_start_button',
        authUserId: ctx.authUserId,
      }),
    });
  }
}

/** "Add another account" button - shows connect options overlay */
export async function handleVerifyAddMore(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  apiBaseUrl: string | undefined,
  ctx: { authUserId: string; guildId: string }
): Promise<void> {
  await interaction.deferUpdate();

  try {
    const panelToken =
      getActiveVerifyPanel(interaction.user.id, ctx.guildId)?.panelToken ??
      createVerifyPanelToken();
    const reply = await buildVerifyStatusReply(
      interaction.user.id,
      ctx.authUserId,
      ctx.guildId,
      convex,
      apiSecret,
      apiBaseUrl,
      { panelToken, stateOverride: 'nothing' }
    );
    const message = await interaction.editReply(reply);
    rememberActiveVerifyPanel(interaction, ctx.authUserId, ctx.guildId, message.id, {
      panelToken,
    });
    await bindVerifyPanelToken(apiBaseUrl, apiSecret, interaction, {
      discordUserId: interaction.user.id,
      guildId: ctx.guildId,
      messageId: message.id,
      panelToken,
      authUserId: ctx.authUserId,
    });
  } catch (err) {
    await interaction.editReply({
      content: await buildBotVerificationErrorMessage(logger, {
        baseMessage: `${E.X_} An error occurred. Please try again.`,
        discordUserId: interaction.user.id,
        error: err,
        guildId: ctx.guildId,
        stage: 'verify_add_more',
        authUserId: ctx.authUserId,
      }),
    });
  }
}

/** /creator-admin spawn-verify - post non-ephemeral verify button in channel */
export async function handleVerifySpawn(
  interaction: ChatInputCommandInteraction,
  _convex: ConvexHttpClient,
  _apiBaseUrl: string | undefined,
  _ctx: { authUserId: string; guildLinkId: Id<'guild_links'>; guildId: string }
): Promise<void> {
  const title = interaction.options.getString('title') ?? DEFAULT_SPAWN_TITLE;
  const description = interaction.options.getString('description') ?? DEFAULT_SPAWN_DESCRIPTION;
  const buttonText = interaction.options.getString('button_text') ?? DEFAULT_SPAWN_BUTTON_TEXT;
  const colorStr = interaction.options.getString('color');
  const imageUrl = interaction.options.getString('image_url');

  let color = DEFAULT_SPAWN_COLOR;
  if (colorStr && /^#[0-9A-Fa-f]{6}$/.test(colorStr)) {
    color = Number.parseInt(colorStr.substring(1), 16);
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: 'Creator Assistant · Secure verification' });

  if (imageUrl) {
    embed.setImage(imageUrl);
  }

  const button = new ButtonBuilder()
    .setCustomId('verify_start')
    .setLabel(buttonText)
    .setEmoji(Emoji.Bag)
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

  await interaction.reply({
    content: `${E.Assistant} Verify message posted. Use the command options (title, description, button_text, color, image_url) to customize it anytime.`,
    flags: MessageFlags.Ephemeral,
  });

  const channel = interaction.channel;
  if (channel && 'send' in channel) {
    await channel.send({
      embeds: [embed],
      components: [row],
    });
  }
}

export function buildLicenseModal(authUserId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${VERIFY_PREFIX}license_modal:${authUserId}`)
    .setTitle('Enter License Key')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('license_key')
          .setLabel('License Key')
          .setPlaceholder('Paste your license key here')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
      )
    );
}

export async function handleLicenseModalSubmit(
  interaction: ModalSubmitInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  apiBaseUrl: string | undefined
): Promise<void> {
  const customId = interaction.customId;
  if (!customId.startsWith(`${VERIFY_PREFIX}license_modal:`)) return;

  const authUserId = customId.slice(`${VERIFY_PREFIX}license_modal:`.length) as string;
  const licenseKey = interaction.fields.getTextInputValue('license_key')?.trim();

  if (!licenseKey) {
    await interaction.reply({
      content: 'License key is required.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId, {
    apiSecret,
    discordUserId: interaction.user.id,
  });

  let subjectId: string;
  if (subjectResult.found) {
    subjectId = subjectResult.subject._id;
  } else {
    const created = await convex.mutation(api.subjects.ensureSubjectForDiscord, {
      apiSecret,
      discordUserId: interaction.user.id,
      displayName: interaction.user.username,
      avatarUrl: interaction.user.displayAvatarURL({ size: 128 }),
    });
    subjectId = created.subjectId as string;
  }

  if (!apiBaseUrl) {
    await interaction.reply({
      content: 'Verification API not configured. Please contact the server admin.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.isFromMessage()) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  try {
    const result = await completeLicenseVerification({
      licenseKey,
      authUserId,
      subjectId,
    });

    if (!result.success) {
      const failureMessage =
        `${E.X_} We couldn’t find a matching purchase. Make sure you’re using the license key from your purchase confirmation.\n\n` +
        `${sanitizeUserFacingErrorMessage(result.error, 'Verification failed.')}`;
      await interaction.editReply({
        content: result.supportCode
          ? formatVerificationSupportMessage(failureMessage, result.supportCode)
          : failureMessage,
      });
      track(interaction.user.id, 'verification_failed', { error: result.error, authUserId });
      return;
    }

    track(interaction.user.id, 'verification_completed', { authUserId, provider: result.provider });

    const guildId = interaction.guildId;
    if (guildId && apiBaseUrl) {
      const panelToken =
        getActiveVerifyPanel(interaction.user.id, guildId)?.panelToken ?? createVerifyPanelToken();
      const connectedProviderLabel = result.provider ? providerLabel(result.provider) : 'account';
      const bannerMessage = `${E.ClapStars} **Connected!** Your ${connectedProviderLabel} account is linked. Your roles will be updated shortly. ${E.Dance}`;
      const reply = await buildVerifyStatusReply(
        interaction.user.id,
        authUserId,
        guildId,
        convex,
        apiSecret,
        apiBaseUrl,
        { bannerMessage, panelToken }
      );
      const message = await interaction.editReply(reply);
      rememberActiveVerifyPanel(interaction, authUserId, guildId, message.id, { panelToken });
      await bindVerifyPanelToken(apiBaseUrl, apiSecret, interaction, {
        discordUserId: interaction.user.id,
        guildId,
        messageId: message.id,
        panelToken,
        authUserId,
      });
    } else {
      await interaction.editReply({
        content: `${E.ClapStars} **Verified!** Your roles will be updated shortly.\n\n${E.Dance} Welcome to the community!`,
      });
    }
  } catch (err) {
    await interaction.editReply({
      content: await buildBotVerificationErrorMessage(logger, {
        baseMessage: `${E.X_} Verification didn’t finish. Try again in a moment.`,
        discordUserId: interaction.user.id,
        error: err,
        guildId: interaction.guildId ?? undefined,
        stage: 'verification_flow',
        authUserId,
      }),
    });
  }
}

export async function handleVerifyDisconnectButton(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  apiBaseUrl: string | undefined,
  provider: string
): Promise<void> {
  const guildId = interaction.guildId;
  let authUserIdForError: string | undefined;
  if (!guildId) {
    await interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!apiBaseUrl) {
    await interaction.reply({
      content: 'Verification API not configured.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  try {
    const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId, {
      apiSecret,
      discordUserId: interaction.user.id,
    });

    if (!subjectResult.found) {
      await interaction.editReply({ content: 'No linked accounts found.' });
      return;
    }

    const guildLink = await convex.query(api.guildLinks.getByDiscordGuildForBot, {
      apiSecret,
      discordGuildId: guildId,
    });

    if (!guildLink) {
      await interaction.editReply({ content: 'Server not configured.' });
      return;
    }
    authUserIdForError = String(guildLink.authUserId);

    const result = await disconnectVerification({
      subjectId: subjectResult.subject._id,
      authUserId: guildLink.authUserId,
      provider,
    });

    if (!result.success) {
      await interaction.editReply({
        content: result.supportCode
          ? formatVerificationSupportMessage(
              sanitizeUserFacingErrorMessage(
                result.error,
                'Couldn’t disconnect this account right now.'
              ),
              result.supportCode
            )
          : sanitizeUserFacingErrorMessage(
              result.error,
              'Couldn’t disconnect this account right now.'
            ),
      });
      return;
    }

    track(interaction.user.id, 'verification_disconnected', {
      authUserId: guildLink.authUserId,
      provider,
    });

    // Refresh and show the updated panel so user sees products/accounts cleared
    const panelToken =
      getActiveVerifyPanel(interaction.user.id, guildId)?.panelToken ?? createVerifyPanelToken();
    const reply = await buildVerifyStatusReply(
      interaction.user.id,
      guildLink.authUserId,
      guildId,
      convex,
      apiSecret,
      apiBaseUrl,
      {
        bannerMessage: `${E.Checkmark} Disconnected your ${providerLabel(provider)} account. Existing roles may take a moment to be removed.`,
        panelToken,
      }
    );
    const message = await interaction.editReply(reply);
    rememberActiveVerifyPanel(interaction, guildLink.authUserId, guildId, message.id, {
      panelToken,
    });
    await bindVerifyPanelToken(apiBaseUrl, apiSecret, interaction, {
      discordUserId: interaction.user.id,
      guildId,
      messageId: message.id,
      panelToken,
      authUserId: guildLink.authUserId,
    });
  } catch (err) {
    // Error path: use plain content (no IsComponentsV2) - legacy content is allowed
    await interaction.editReply({
      content: await buildBotVerificationErrorMessage(logger, {
        baseMessage: `${E.X_} Couldn’t disconnect this account right now. Try again in a moment.`,
        discordUserId: interaction.user.id,
        error: err,
        guildId,
        provider,
        stage: 'verify_disconnect',
        authUserId: authUserIdForError,
      }),
    });
  }
}

export async function handleRefreshCommand(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { authUserId: string }
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: 'This command must be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const result = await convex.mutation(api.entitlements.enqueueRoleSyncsForUser, {
      apiSecret,
      authUserId: ctx.authUserId,
      discordUserId: interaction.user.id,
    });

    if (!result.success) {
      await interaction.editReply({
        content: `${E.X_} Could not find your verification profile. Please make sure you have connected an account.`,
      });
      return;
    }

    const apiBaseUrl = process.env.API_BASE_URL;

    if (apiBaseUrl) {
      const [data, providersResult] = await Promise.all([
        fetchVerifyData(interaction.user.id, ctx.authUserId, guildId, convex, apiSecret),
        convex.query(api.role_rules.getEnabledVerificationProvidersFromProducts, {
          apiSecret,
          authUserId: ctx.authUserId,
          guildId,
        }),
      ]);
      const enabledSet = new Set<string>((providersResult as { providers: string[] }).providers);

      const bannerMessage = `${E.Checkmark} Queued ${result.jobsCreated} role sync jobs! Your roles in this server will be updated momentarily.`;
      const container = buildStatusContainer(
        data,
        ctx.authUserId,
        guildId,
        apiBaseUrl,
        enabledSet,
        undefined,
        interaction.user.id,
        bannerMessage
      );

      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [container],
      });
    } else {
      await interaction.editReply({
        content: `${E.Checkmark} Queued ${result.jobsCreated} role sync jobs! Your roles in this server will be updated momentarily.`,
      });
    }
  } catch (err) {
    await interaction.editReply({
      content: await buildBotVerificationErrorMessage(logger, {
        baseMessage: `${E.X_} Couldn’t refresh your verification status right now. Try again in a moment.`,
        discordUserId: interaction.user.id,
        error: err,
        guildId,
        stage: 'verify_refresh',
        authUserId: ctx.authUserId,
      }),
    });
  }
}
