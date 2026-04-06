/**
 * License Key Verification - Product Picker Flow
 *
 * Flow:
 *   1. User clicks "Use License Key" button
 *      → showProductPicker(): loads tenant's products, renders StringSelectMenu
 *         with filter buttons (All / Gumroad / Jinxxy) and pagination (Prev/Next).
 *   2. User selects a product from the select menu
 *      → handleProductSelected(): shows a modal pre-titled with the product name.
 *   3. User submits the license key modal
 *      → handleLicenseKeyModal(): calls the API, on success:
 *         - Creates external_account (syncUserFromProvider)
 *         - Creates tenant binding (activateBinding) → account now appears "connected"
 *         - Refreshes the verify status panel
 *
 * Custom ID conventions:
 *   Button (open picker):   creator_verify:license:{authUserId}
 *   Button (filter):        creator_verify:lp_filter:{authUserId}:{filter}:{page}
 *   Button (page):          creator_verify:lp_page:{authUserId}:{filter}:{page}
 *   Select menu:            creator_verify:lp_select:{authUserId}:{filter}:{page}
 *   Modal:                  creator_verify:lp_modal:{authUserId}:{productRef}:{provider}
 */

import { PROVIDER_META, providerLabel } from '@yucp/providers';
import { getProviderDescriptor } from '@yucp/providers/providerMetadata';
import { createLogger, formatVerificationSupportMessage } from '@yucp/shared';
import { ConvexHttpClient } from 'convex/browser';
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import { E, Emoji } from '../lib/emojis';
import {
  completeLicenseVerification,
  completeVrchatVerification,
  listProviderProducts,
} from '../lib/internalRpc';
import { sanitizeUserFacingErrorMessage } from '../lib/userFacingErrors';
import { buildBotVerificationErrorMessage } from '../lib/verificationSupport';
import { buildVerifyStatusReply, rememberActiveVerifyPanel } from './verify';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const PAGE_SIZE = 20; // Leave room for filter/nav rows (max 25 per select menu)

type Filter = 'all' | string;
// biome-ignore lint/suspicious/noExplicitAny: Discord container rows mix button and select builders here.
type ProductPickerRow = ActionRowBuilder<any>;

interface Product {
  _id: string;
  productId: string;
  provider: string;
  providerProductRef: string;
  canonicalSlug?: string;
  displayName?: string;
}

// ── Helper: build the product picker message ──────────────────────────────────

function buildProductPickerComponents(
  products: Product[],
  authUserId: string,
  filter: Filter,
  page: number
): {
  components: ProductPickerRow[];
  total: number;
  totalPages: number;
} {
  // Filter
  const filtered = filter === 'all' ? products : products.filter((p) => p.provider === filter);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Row 1 - Filter buttons: "All" + one button per unique provider present (max 4 providers)
  const presentProviders = [...new Set(products.map((p) => p.provider))].slice(0, 4);
  const allBtn = new ButtonBuilder()
    .setCustomId(`creator_verify:lp_filter:${authUserId}:all:0`)
    .setLabel('All')
    .setStyle(filter === 'all' ? ButtonStyle.Primary : ButtonStyle.Secondary);

  const providerBtns = presentProviders.map((prov) => {
    const meta = PROVIDER_META[prov as keyof typeof PROVIDER_META];
    const btn = new ButtonBuilder()
      .setCustomId(`creator_verify:lp_filter:${authUserId}:${prov}:0`)
      .setLabel(meta?.label ?? prov)
      .setStyle(filter === prov ? ButtonStyle.Primary : ButtonStyle.Secondary);
    if (meta?.emojiKey && Emoji[meta.emojiKey as keyof typeof Emoji]) {
      btn.setEmoji(Emoji[meta.emojiKey as keyof typeof Emoji]);
    }
    return btn;
  });

  const filterRow = new ActionRowBuilder<ButtonBuilder>().addComponents(allBtn, ...providerBtns);

  const rows: ProductPickerRow[] = [filterRow];

  if (slice.length === 0) {
    // No products for this filter - still render but disabled
    const emptyMenu = new StringSelectMenuBuilder()
      .setCustomId(`creator_verify:lp_select:${authUserId}:${filter}:${safePage}`)
      .setPlaceholder('No products found for this filter')
      .setDisabled(true)
      .addOptions(new StringSelectMenuOptionBuilder().setLabel('(empty)').setValue('__empty__'));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(emptyMenu));
    return { components: rows, total: 0, totalPages };
  }

  // Row 2 - Product select menu
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`creator_verify:lp_select:${authUserId}:${filter}:${safePage}`)
    .setPlaceholder('Select a product to verify…')
    .addOptions(
      slice.map((p) => {
        const meta = PROVIDER_META[p.provider as keyof typeof PROVIDER_META];
        const label = p.displayName ?? p.canonicalSlug ?? p.productId;
        const opt = new StringSelectMenuOptionBuilder()
          .setLabel(label.slice(0, 100))
          .setValue(`${p.provider}::${p.providerProductRef}`)
          .setDescription(meta?.addProductDescription ?? p.provider);
        if (meta?.emojiKey && Emoji[meta.emojiKey as keyof typeof Emoji]) {
          opt.setEmoji(Emoji[meta.emojiKey as keyof typeof Emoji]);
        }
        return opt;
      })
    );

  rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));

  // Row 3 - Pagination (only if > 1 page)
  if (totalPages > 1) {
    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`creator_verify:lp_page:${authUserId}:${filter}:${safePage - 1}`)
        .setLabel('◀ Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage === 0),
      new ButtonBuilder()
        .setCustomId(`creator_verify:lp_page:${authUserId}:${filter}:${safePage + 1}`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages - 1)
    );
    rows.push(navRow);
  }

  return { components: rows, total: filtered.length, totalPages };
}

function buildProductPickerReply(
  products: Product[],
  authUserId: string,
  filter: Filter,
  page: number
): {
  components: [ContainerBuilder];
  flags: MessageFlags.IsComponentsV2;
} {
  const { components, total, totalPages } = buildProductPickerComponents(
    products,
    authUserId,
    filter,
    page
  );

  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const headerParts: string[] = [];
  if (total > PAGE_SIZE) {
    headerParts.push(`Page ${safePage + 1}/${totalPages}`);
  }
  headerParts.push(`${total} product${total !== 1 ? 's' : ''} available`);

  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${E.Bag} Choose a Product to Verify\n${headerParts.join(' · ')}`
    )
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );
  container.addActionRowComponents(...components);

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}

function buildPickerErrorReply(message: string): {
  components: [ContainerBuilder];
  flags: MessageFlags.IsComponentsV2;
} {
  const container = new ContainerBuilder().setAccentColor(0xed4245);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${E.X_} ${message}`));
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}

// ── Public: show the product picker (called from button handler) ───────────────

/**
 * Enrich display names for products where displayName is missing.
 * Uses the private internal RPC catalog service for providers that support
 * server-side product lookup.
 */
async function enrichDisplayNames(
  products: Product[],
  authUserId: string,
  _apiSecret: string
): Promise<Product[]> {
  // Find unique providers that have products needing display name enrichment
  const providersMissingNames = [
    ...new Set(products.filter((p) => !p.displayName).map((p) => p.provider)),
  ];
  if (providersMissingNames.length === 0) return products;

  const namesByProvider = new Map<string, Record<string, string>>();
  await Promise.all(
    providersMissingNames.map(async (provider) => {
      try {
        let providerProducts: Array<{ id: string; name: string }> = [];

        providerProducts = (await listProviderProducts(provider, authUserId)).products ?? [];

        const nameById = Object.fromEntries(
          providerProducts.map((product) => [String(product.id), product.name])
        );
        namesByProvider.set(provider, nameById);
      } catch (err) {
        logger.warn('Failed to enrich display names', { provider, err });
      }
    })
  );
  return products.map((p) => {
    if (!p.displayName) {
      const nameById = namesByProvider.get(p.provider);
      if (nameById) {
        const name = nameById[String(p.providerProductRef)];
        if (name) return { ...p, displayName: name };
      }
    }
    return p;
  });
}

export async function showProductPicker(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  authUserId: string,
  filter: Filter = 'all',
  page = 0
) {
  await interaction.deferUpdate();

  let products: Product[] = [];
  try {
    products = (await convex.query(api.productResolution.getProductsForTenant, {
      apiSecret,
      authUserId,
    })) as Product[];
    products = await enrichDisplayNames(products, authUserId, apiSecret);
  } catch (err) {
    logger.error('Failed to load products for picker', { err });
  }

  if (products.length === 0) {
    const message = await interaction.editReply(
      buildPickerErrorReply(
        'No products are configured for this server yet. Ask the creator to run `/creator-admin product add`.'
      )
    );
    if (interaction.guildId) {
      rememberActiveVerifyPanel(interaction, authUserId, interaction.guildId, message.id);
    }
    return;
  }

  const message = await interaction.editReply(
    buildProductPickerReply(products, authUserId, filter, page)
  );
  if (interaction.guildId) {
    rememberActiveVerifyPanel(interaction, authUserId, interaction.guildId, message.id);
  }
}

// ── Public: re-render picker on filter/page button press ─────────────────────

export async function handlePickerNavigation(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  authUserId: string,
  filter: Filter,
  page: number
) {
  await interaction.deferUpdate();

  let products: Product[] = [];
  try {
    products = (await convex.query(api.productResolution.getProductsForTenant, {
      apiSecret,
      authUserId,
    })) as Product[];
    products = await enrichDisplayNames(products, authUserId, apiSecret);
  } catch (err) {
    logger.error('Failed to reload products for picker nav', { err });
  }

  const message = await interaction.editReply(
    buildProductPickerReply(products, authUserId, filter, page)
  );
  if (interaction.guildId) {
    rememberActiveVerifyPanel(interaction, authUserId, interaction.guildId, message.id);
  }
}

// ── Public: product selected → show license key modal ────────────────────────

export async function handleProductSelected(
  interaction: StringSelectMenuInteraction,
  authUserId: string
) {
  // Value format: "{provider}::{providerProductRef}"
  const value = interaction.values[0];
  if (!value || value === '__empty__') {
    await interaction.reply({
      content: 'Please select a valid product.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sepIdx = value.indexOf('::');
  if (sepIdx === -1) {
    await interaction.reply({ content: 'Invalid selection.', flags: MessageFlags.Ephemeral });
    return;
  }

  const provider = value.slice(0, sepIdx);
  const providerProductRef = value.slice(sepIdx + 2);
  const meta = PROVIDER_META[provider as keyof typeof PROVIDER_META];
  const providerLabel = meta?.label ?? provider;

  const modal = new ModalBuilder()
    .setCustomId(`creator_verify:lp_modal:${authUserId}:${providerProductRef}:${provider}`)
    .setTitle(`Enter ${providerLabel} License Key`);

  const descriptor = getProviderDescriptor(provider);
  const licenseConfig = descriptor?.licenseKey ?? {
    inputLabel: 'License Key',
    placeholder: 'Enter your license key',
  };
  const keyInput = new TextInputBuilder()
    .setCustomId('license_key')
    .setLabel(licenseConfig.inputLabel)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(licenseConfig.placeholder)
    .setRequired(true)
    .setMinLength(8)
    .setMaxLength(200);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(keyInput));
  await interaction.showModal(modal);
}

// ── VRChat credentials modal ──────────────────────────────────────────────────

const _VRC_DISCLAIMER = 'We never store your password, username, or 2FA code.';

export function buildVrchatCredentialsModal(authUserId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`creator_verify:vrchat_modal:${authUserId}`)
    .setTitle('Verify with VRChat')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('vrchat_username')
          .setLabel('VRChat Username')
          .setPlaceholder('Your VRChat login')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('vrchat_password')
          .setLabel('VRChat Password')
          .setPlaceholder('Your VRChat password')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('vrchat_2fa')
          .setLabel('2FA Code (optional)')
          .setPlaceholder("Leave empty if you don't use 2FA")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
      )
    );
}

export async function handleVrchatCredentialsModal(
  interaction: ModalSubmitInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  _apiBaseUrl: string | undefined
): Promise<void> {
  const customId = interaction.customId;
  if (!customId.startsWith('creator_verify:vrchat_modal:')) return;

  const authUserId = customId.slice('creator_verify:vrchat_modal:'.length) as string;
  const username = interaction.fields.getTextInputValue('vrchat_username')?.trim() ?? '';
  const password = interaction.fields.getTextInputValue('vrchat_password') ?? '';
  const twoFactorCode = interaction.fields.getTextInputValue('vrchat_2fa')?.trim() || undefined;

  if (!username) {
    await interaction.reply({
      content: `${E.X_} Please enter your VRChat username.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!password) {
    await interaction.reply({
      content: `${E.X_} Please enter your VRChat password.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const discordUserId = interaction.user.id;
  let subjectId: string | null = null;

  try {
    const ensureResult = await convex.mutation(api.subjects.ensureSubjectForDiscord, {
      apiSecret,
      discordUserId,
      displayName: interaction.user.displayName,
      avatarUrl: interaction.user.displayAvatarURL(),
    });
    subjectId = ensureResult.subjectId;
    if (!subjectId) {
      throw new Error('Subject lookup did not return a subjectId');
    }
  } catch (err) {
    logger.error('Failed to ensure subject for VRChat', { err, discordUserId });
    await interaction.editReply({
      content: `${E.X_} Failed to look up your account. Please try again.`,
    });
    return;
  }

  try {
    const data = await completeVrchatVerification({
      authUserId,
      subjectId,
      username,
      password,
      twoFactorCode,
    });

    if (!data.success) {
      const msg = sanitizeUserFacingErrorMessage(data.error, 'Verification failed.');
      await interaction.editReply({
        content: data.supportCode
          ? formatVerificationSupportMessage(`${E.X_} ${msg}`, data.supportCode)
          : `${E.X_} ${msg}`,
      });
      return;
    }

    const count = data.entitlementIds?.length ?? 0;
    await interaction.editReply({
      content:
        `${E.ClapStars} ${E.VRC} **VRChat verified!**\n` +
        `Your account has been linked. ${count > 0 ? `Verified ${count} product${count !== 1 ? 's' : ''}. ` : ''}Run \`/creator\` to see your status.`,
    });
  } catch (err) {
    await interaction.editReply({
      content: await buildBotVerificationErrorMessage(logger, {
        baseMessage: `${E.X_} An error occurred. Please try again.`,
        discordUserId: interaction.user.id,
        error: err,
        guildId: interaction.guildId ?? undefined,
        provider: 'vrchat',
        stage: 'vrchat_verify_request',
        authUserId,
      }),
    });
  }
}

// ── Public: license key modal submitted → verify + link ───────────────────────

export async function handleLicenseKeyModal(
  interaction: ModalSubmitInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  apiBaseUrl: string | undefined
) {
  // customId: creator_verify:lp_modal:{authUserId}:{providerProductRef}:{provider}
  const rest = interaction.customId.slice('creator_verify:lp_modal:'.length);
  // authUserId is first segment, providerProductRef can contain colons in edge cases,
  // so provider is the final segment, authUserId is the first, middle is providerProductRef
  const firstColon = rest.indexOf(':');
  const lastColon = rest.lastIndexOf(':');
  if (firstColon === -1 || lastColon === firstColon) {
    await interaction.reply({
      content: `${E.X_} Invalid modal state.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const authUserId = rest.slice(0, firstColon) as string;
  const provider = rest.slice(lastColon + 1);
  const providerProductRef = rest.slice(firstColon + 1, lastColon);
  const licenseKey = interaction.fields.getTextInputValue('license_key').trim();

  // DEBUG: log all parsed values so we can see what productId goes to Gumroad
  logger.info('[licenseVerify] Modal submitted', {
    rawCustomId: interaction.customId,
    authUserId: String(authUserId),
    provider,
    providerProductRef,
    licenseKeyLength: licenseKey.length,
  });

  if (!licenseKey) {
    await interaction.reply({
      content: `${E.X_} Please enter a license key.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const updatesExistingPanel = interaction.isFromMessage() && Boolean(interaction.guildId);
  if (updatesExistingPanel) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  // Find / create the subject for this Discord user
  const discordUserId = interaction.user.id;
  let subjectId: string | null = null;

  try {
    const ensureResult = await convex.mutation(api.subjects.ensureSubjectForDiscord, {
      apiSecret,
      discordUserId,
      displayName: interaction.user.displayName,
      avatarUrl: interaction.user.displayAvatarURL(),
    });
    subjectId = ensureResult.subjectId;
  } catch (err) {
    logger.error('Failed to ensure subject', { err, discordUserId });
    if (interaction.guildId && apiBaseUrl) {
      const message = await interaction.editReply(
        await buildVerifyStatusReply(
          interaction.user.id,
          authUserId,
          interaction.guildId,
          convex,
          apiSecret,
          apiBaseUrl,
          { bannerMessage: `${E.X_} Failed to look up your account. Please try again.` }
        )
      );
      rememberActiveVerifyPanel(interaction, authUserId, interaction.guildId, message.id);
    } else {
      await interaction.editReply({
        content: `${E.X_} Failed to look up your account. Please try again.`,
      });
    }
    return;
  }

  try {
    const data = await completeLicenseVerification({
      licenseKey,
      productId: providerProductRef,
      provider,
      authUserId,
      subjectId: subjectId ?? discordUserId,
      discordUserId,
    });

    if (!data.success) {
      const msg = sanitizeUserFacingErrorMessage(data.error, 'Verification failed.');
      const bannerMessage = data.supportCode
        ? formatVerificationSupportMessage(`${E.X_} ${msg}`, data.supportCode)
        : `${E.X_} ${msg}`;
      logger.warn('License verification failed', { msg, authUserId, provider });
      if (interaction.guildId && apiBaseUrl) {
        const message = await interaction.editReply(
          await buildVerifyStatusReply(
            interaction.user.id,
            authUserId,
            interaction.guildId,
            convex,
            apiSecret,
            apiBaseUrl,
            { bannerMessage }
          )
        );
        rememberActiveVerifyPanel(interaction, authUserId, interaction.guildId, message.id);
      } else {
        await interaction.editReply({ content: bannerMessage });
      }
      return;
    }

    // License verified! Now ensure a binding exists so the account shows as connected.
    // completeLicense already does this internally, but as belt-and-suspenders also
    // do a direct syncUserFromProvider to ensure the external_account is linked.
    // (The binding creation is already handled inside completeLicense + sessionManager.)

    const label = providerLabel(provider);
    const meta = PROVIDER_META[provider as keyof typeof PROVIDER_META];
    const emoji = meta?.emojiKey ? (E[meta.emojiKey as keyof typeof E] ?? '') : '';
    if (interaction.guildId && apiBaseUrl) {
      const message = await interaction.editReply(
        await buildVerifyStatusReply(
          interaction.user.id,
          authUserId,
          interaction.guildId,
          convex,
          apiSecret,
          apiBaseUrl,
          {
            bannerMessage: `${E.ClapStars} ${emoji} **${label} license verified!**\nYour account has been linked. Your roles will be updated shortly.`,
          }
        )
      );
      rememberActiveVerifyPanel(interaction, authUserId, interaction.guildId, message.id);
    } else {
      await interaction.editReply({
        content: `${E.ClapStars} ${emoji} **${label} license verified!**\nYour account has been linked. Run \`/creator\` to see your updated verification status.`,
      });
    }
  } catch (err) {
    if (interaction.guildId && apiBaseUrl) {
      const message = await interaction.editReply(
        await buildVerifyStatusReply(
          interaction.user.id,
          authUserId,
          interaction.guildId,
          convex,
          apiSecret,
          apiBaseUrl,
          {
            bannerMessage: await buildBotVerificationErrorMessage(logger, {
              baseMessage: `${E.X_} An error occurred. Please try again.`,
              discordUserId: interaction.user.id,
              error: err,
              guildId: interaction.guildId,
              provider,
              stage: 'license_key_verify_request',
              authUserId,
            }),
          }
        )
      );
      rememberActiveVerifyPanel(interaction, authUserId, interaction.guildId, message.id);
    } else {
      await interaction.editReply({
        content: await buildBotVerificationErrorMessage(logger, {
          baseMessage: `${E.X_} An error occurred. Please try again.`,
          discordUserId: interaction.user.id,
          error: err,
          guildId: interaction.guildId ?? undefined,
          provider,
          stage: 'license_key_verify_request',
          authUserId,
        }),
      });
    }
  }
}
