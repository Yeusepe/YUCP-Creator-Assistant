/**
 * License Key Verification — Product Picker Flow
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
 *   Button (open picker):   creator_verify:license:{tenantId}
 *   Button (filter):        creator_verify:lp_filter:{tenantId}:{filter}:{page}
 *   Button (page):          creator_verify:lp_page:{tenantId}:{filter}:{page}
 *   Select menu:            creator_verify:lp_select:{tenantId}:{filter}:{page}
 *   Modal:                  creator_verify:lp_modal:{tenantId}:{productRef}:{provider}
 */

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle,
    type ButtonInteraction,
    type ModalSubmitInteraction,
    type StringSelectMenuInteraction,
} from 'discord.js';
import { ConvexHttpClient } from 'convex/browser';
import { createLogger } from '@yucp/shared';
import type { Id } from '../../../../convex/_generated/dataModel';

import { E, Emoji } from '../lib/emojis';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const PAGE_SIZE = 20; // Leave room for filter/nav rows (max 25 per select menu)

type Filter = 'all' | 'gumroad' | 'jinxxy';

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
    tenantId: string,
    filter: Filter,
    page: number,
): {
    components: ActionRowBuilder<any>[];
    total: number;
    totalPages: number;
} {
    // Filter
    const filtered = products.filter((p) => {
        if (filter === 'gumroad') return p.provider === 'gumroad';
        if (filter === 'jinxxy') return p.provider === 'jinxxy';
        return true;
    });

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(0, page), totalPages - 1);
    const slice = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

    // Row 1 — Filter buttons
    const filterRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`creator_verify:lp_filter:${tenantId}:all:0`)
            .setLabel('All')
            .setStyle(filter === 'all' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`creator_verify:lp_filter:${tenantId}:gumroad:0`)
            .setLabel('Gumroad')
            .setEmoji(Emoji.Gumorad)
            .setStyle(filter === 'gumroad' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`creator_verify:lp_filter:${tenantId}:jinxxy:0`)
            .setLabel('Jinxxy')
            .setEmoji(Emoji.Jinxxy)
            .setStyle(filter === 'jinxxy' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );

    const rows: ActionRowBuilder<any>[] = [filterRow];

    if (slice.length === 0) {
        // No products for this filter — still render but disabled
        const emptyMenu = new StringSelectMenuBuilder()
            .setCustomId(`creator_verify:lp_select:${tenantId}:${filter}:${safePage}`)
            .setPlaceholder('No products found for this filter')
            .setDisabled(true)
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('(empty)').setValue('__empty__'),
            );
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(emptyMenu));
        return { components: rows, total: 0, totalPages };
    }

    // Row 2 — Product select menu
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`creator_verify:lp_select:${tenantId}:${filter}:${safePage}`)
        .setPlaceholder('Select a product to verify…')
        .addOptions(
            slice.map((p) => {
                const isGumroad = p.provider === 'gumroad';
                const label = p.displayName ?? p.canonicalSlug ?? p.productId;
                const opt = new StringSelectMenuOptionBuilder()
                    .setLabel(label.slice(0, 100))
                    .setValue(`${p.provider}::${p.providerProductRef}`)
                    .setDescription(isGumroad ? 'Gumroad product' : 'Jinxxy product')
                    .setEmoji(isGumroad ? Emoji.Gumorad : Emoji.Jinxxy);
                return opt;
            }),
        );

    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));

    // Row 3 — Pagination (only if > 1 page)
    if (totalPages > 1) {
        const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`creator_verify:lp_page:${tenantId}:${filter}:${safePage - 1}`)
                .setLabel('◀ Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(safePage === 0),
            new ButtonBuilder()
                .setCustomId(`creator_verify:lp_page:${tenantId}:${filter}:${safePage + 1}`)
                .setLabel('Next ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(safePage >= totalPages - 1),
        );
        rows.push(navRow);
    }

    return { components: rows, total: filtered.length, totalPages };
}

// ── Public: show the product picker (called from button handler) ───────────────

async function enrichJinxxyDisplayNames(
    products: Product[],
    tenantId: string,
    apiSecret: string,
): Promise<Product[]> {
    const needsEnrichment = products.filter((p) => p.provider === 'jinxxy' && !p.displayName);
    if (needsEnrichment.length === 0) return products;

    const apiBase = process.env.API_BASE_URL;
    if (!apiBase) return products;

    try {
        const res = await fetch(`${apiBase}/api/jinxxy/products`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiSecret, tenantId }),
        });
        const data = (await res.json()) as { products?: { id: string; name: string }[] };
        const apiProducts = data.products ?? [];
        const nameById = Object.fromEntries(apiProducts.map((p) => [String(p.id), p.name]));

        return products.map((p) => {
            if (p.provider === 'jinxxy' && !p.displayName) {
                const name = nameById[String(p.providerProductRef)];
                if (name) return { ...p, displayName: name };
            }
            return p;
        });
    } catch (err) {
        logger.warn('Failed to enrich Jinxxy display names', { err });
        return products;
    }
}

export async function showProductPicker(
    interaction: ButtonInteraction,
    convex: ConvexHttpClient,
    apiSecret: string,
    tenantId: Id<'tenants'>,
    filter: Filter = 'all',
    page = 0,
) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let products: Product[] = [];
    try {
        products = (await convex.query('productResolution:getProductsForTenant' as any, {
            tenantId,
        })) as Product[];
        products = await enrichJinxxyDisplayNames(products, tenantId, apiSecret);
    } catch (err) {
        logger.error('Failed to load products for picker', { err });
    }

    if (products.length === 0) {
        await interaction.editReply({
            content:
                `${E.X_} No products are configured for this server yet. Ask the creator to run \`/creator-admin product add\`.`,
        });
        return;
    }

    const { components, total, totalPages } = buildProductPickerComponents(
        products,
        tenantId,
        filter,
        page,
    );

    const safePage = Math.min(Math.max(0, page), totalPages - 1);
    const headerParts: string[] = [];
    if (total > PAGE_SIZE) {
        headerParts.push(`Page ${safePage + 1}/${totalPages}`);
    }
    headerParts.push(`${total} product${total !== 1 ? 's' : ''} available`);

    await interaction.editReply({
        content: `## ${E.Bag} Choose a Product to Verify\n${headerParts.join(' · ')}`,
        components,
    });
}

// ── Public: re-render picker on filter/page button press ─────────────────────

export async function handlePickerNavigation(
    interaction: ButtonInteraction,
    convex: ConvexHttpClient,
    apiSecret: string,
    tenantId: Id<'tenants'>,
    filter: Filter,
    page: number,
) {
    await interaction.deferUpdate();

    let products: Product[] = [];
    try {
        products = (await convex.query('productResolution:getProductsForTenant' as any, {
            tenantId,
        })) as Product[];
        products = await enrichJinxxyDisplayNames(products, tenantId, apiSecret);
    } catch (err) {
        logger.error('Failed to reload products for picker nav', { err });
    }

    const { components, total, totalPages } = buildProductPickerComponents(
        products,
        tenantId,
        filter,
        page,
    );

    const safePage = Math.min(Math.max(0, page), totalPages - 1);
    const headerParts: string[] = [];
    if (total > PAGE_SIZE) {
        headerParts.push(`Page ${safePage + 1}/${totalPages}`);
    }
    headerParts.push(`${total} product${total !== 1 ? 's' : ''} available`);

    await interaction.editReply({
        content: `## ${E.Bag} Choose a Product to Verify\n${headerParts.join(' · ')}`,
        components,
    });
}

// ── Public: product selected → show license key modal ────────────────────────

export async function handleProductSelected(
    interaction: StringSelectMenuInteraction,
    tenantId: Id<'tenants'>,
) {
    // Value format: "{provider}::{providerProductRef}"
    const value = interaction.values[0];
    if (!value || value === '__empty__') {
        await interaction.reply({ content: 'Please select a valid product.', flags: MessageFlags.Ephemeral });
        return;
    }

    const sepIdx = value.indexOf('::');
    if (sepIdx === -1) {
        await interaction.reply({ content: 'Invalid selection.', flags: MessageFlags.Ephemeral });
        return;
    }

    const provider = value.slice(0, sepIdx);
    const providerProductRef = value.slice(sepIdx + 2);
    const isGumroad = provider === 'gumroad';

    const modal = new ModalBuilder()
        .setCustomId(`creator_verify:lp_modal:${tenantId}:${providerProductRef}:${provider}`)
        .setTitle(isGumroad ? 'Enter Gumroad License Key' : 'Enter Jinxxy License Key');

    const keyInput = new TextInputBuilder()
        .setCustomId('license_key')
        .setLabel(isGumroad ? 'License Key (XXXX-XXXX-XXXX-XXXX)' : 'License Key')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(isGumroad ? 'XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX' : 'Enter your license key')
        .setRequired(true)
        .setMinLength(8)
        .setMaxLength(200);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(keyInput));
    await interaction.showModal(modal);
}

// ── Public: license key modal submitted → verify + link ───────────────────────

export async function handleLicenseKeyModal(
    interaction: ModalSubmitInteraction,
    convex: ConvexHttpClient,
    apiSecret: string,
    apiBaseUrl: string | undefined,
) {
    // customId: creator_verify:lp_modal:{tenantId}:{providerProductRef}:{provider}
    const rest = interaction.customId.slice('creator_verify:lp_modal:'.length);
    // tenantId is first segment, providerProductRef can contain colons in edge cases,
    // so provider is the final segment, tenantId is the first, middle is providerProductRef
    const firstColon = rest.indexOf(':');
    const lastColon = rest.lastIndexOf(':');
    if (firstColon === -1 || lastColon === firstColon) {
        await interaction.reply({ content: `${E.X_} Invalid modal state.`, flags: MessageFlags.Ephemeral });
        return;
    }

    const tenantId = rest.slice(0, firstColon) as Id<'tenants'>;
    const provider = rest.slice(lastColon + 1);
    const providerProductRef = rest.slice(firstColon + 1, lastColon);
    const licenseKey = interaction.fields.getTextInputValue('license_key').trim();

    // DEBUG: log all parsed values so we can see what productId goes to Gumroad
    logger.info('[licenseVerify] Modal submitted', {
        rawCustomId: interaction.customId,
        tenantId: String(tenantId),
        provider,
        providerProductRef,
        licenseKeyPrefix: licenseKey.slice(0, 8),
        licenseKeyLength: licenseKey.length,
    });

    if (!licenseKey) {
        await interaction.reply({ content: `${E.X_} Please enter a license key.`, flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Find / create the subject for this Discord user
    const discordUserId = interaction.user.id;
    let subjectId: string | null = null;

    try {
        const ensureResult = await convex.mutation('subjects:ensureSubjectForDiscord' as any, {
            apiSecret,
            discordUserId,
            displayName: interaction.user.displayName,
            avatarUrl: interaction.user.displayAvatarURL(),
        });
        subjectId = ensureResult.subjectId;
    } catch (err) {
        logger.error('Failed to ensure subject', { err, discordUserId });
        await interaction.editReply({ content: `${E.X_} Failed to look up your account. Please try again.` });
        return;
    }

    // Call the API to verify the license key
    const apiUrl = apiBaseUrl ?? process.env.API_BASE_URL;
    if (!apiUrl) {
        await interaction.editReply({ content: `${E.X_} API not available right now.` });
        return;
    }

    try {
        const res = await fetch(`${apiUrl}/api/verification/complete-license`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                licenseKey,
                productId: providerProductRef,
                tenantId,
                subjectId,
                discordUserId,       // so the API can also create the binding
            }),
        });

        const data = (await res.json()) as { success: boolean; error?: string };

        if (!data.success) {
            const msg = data.error ?? 'Verification failed';
            logger.warn('License verification failed', { msg, tenantId, provider });
            await interaction.editReply({ content: `${E.X_} ${msg}` });
            return;
        }

        // License verified! Now ensure a binding exists so the account shows as connected.
        // completeLicense already does this internally, but as belt-and-suspenders also
        // do a direct syncUserFromProvider to ensure the external_account is linked.
        // (The binding creation is already handled inside completeLicense + sessionManager.)

        const providerLabel = provider === 'gumroad' ? 'Gumroad' : 'Jinxxy';
        const emoji = provider === 'gumroad' ? E.Gumorad : E.Jinxxy;

        await interaction.editReply({
            content:
                `${E.ClapStars} ${emoji} **${providerLabel} license verified!**\n` +
                `Your account has been linked. Run \`/creator\` to see your updated verification status.`,
        });
    } catch (err) {
        logger.error('License key verification request failed', { err });
        await interaction.editReply({ content: `${E.X_} An error occurred. Please try again.` });
    }
}
