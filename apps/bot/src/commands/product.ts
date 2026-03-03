/**
 * /creator product - Product-role mapping commands
 *
 * add: Link product to role (cross-server, Gumroad, Jinxxy, Discord role)
 * list: List product-role mappings
 * remove: Remove a product mapping
 */

import { EmbedBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import { track } from '../lib/posthog';

function parseGumroadProductId(urlOrId: string): string | null {
  const trimmed = urlOrId.trim();
  const gumroadMatch = trimmed.match(/gumroad\.com\/l\/([a-zA-Z0-9_-]+)/);
  if (gumroadMatch) return gumroadMatch[1];
  const productMatch = trimmed.match(/gumroad\.com\/products\/([a-zA-Z0-9_-]+)/);
  if (productMatch) return productMatch[1];
  if (/^[a-zA-Z0-9_-]{3,}$/.test(trimmed)) return trimmed;
  return null;
}

function parseJinxxyProductId(urlOrId: string): string | null {
  const trimmed = urlOrId.trim();
  const match = trimmed.match(/jinxxy\.(?:com|app)\/.*\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{3,}$/.test(trimmed)) return trimmed;
  return null;
}

export async function handleProductAdd(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildLinkId: Id<'guild_links'>; guildId: string },
): Promise<void> {
  const source = interaction.options.getString('source', true);
  const urlOrId = interaction.options.getString('url_or_id');
  const sourceGuildId = interaction.options.getString('source_guild_id');
  const sourceRoleId = interaction.options.getString('source_role_id');
  const role = interaction.options.getRole('role', true);

  if (!urlOrId && (source === 'cross_server' || source === 'gumroad' || source === 'jinxxy')) {
    await interaction.reply({
      content: 'Product URL or ID is required for this source type.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    let productId: string;
    let catalogProductId: Id<'product_catalog'> | undefined;

    if (source === 'cross_server') {
      const resolved = await convex.query(api.role_rules.resolveProductByUrl as any, {
        url: urlOrId!,
      });
      if (!resolved) {
        await interaction.editReply({
          content:
            'Product not found for cross-server verification. Add the product link in the catalog first.',
        });
        return;
      }
      productId = resolved.productId;
      catalogProductId = resolved.catalogProductId;
    } else if (source === 'gumroad') {
      const parsed = parseGumroadProductId(urlOrId!);
      if (!parsed) {
        await interaction.editReply({
          content: 'Could not parse Gumroad product ID from URL. Use format: gumroad.com/l/xxx or gumroad.com/products/xxx',
        });
        return;
      }
      const result = await convex.mutation(api.role_rules.addProductFromGumroad as any, {
        apiSecret,
        tenantId: ctx.tenantId,
        productId: parsed,
        providerProductRef: parsed,
      });
      productId = result.productId;
      catalogProductId = result.catalogProductId;
    } else if (source === 'jinxxy') {
      const parsed = parseJinxxyProductId(urlOrId!);
      if (!parsed) {
        await interaction.editReply({
          content: 'Could not parse Jinxxy product ID from URL.',
        });
        return;
      }
      const result = await convex.mutation(api.role_rules.addProductFromJinxxy as any, {
        apiSecret,
        tenantId: ctx.tenantId,
        productId: parsed,
        providerProductRef: parsed,
      });
      productId = result.productId;
      catalogProductId = result.catalogProductId;
    } else if (source === 'discord_role') {
      if (!sourceGuildId || !sourceRoleId) {
        await interaction.editReply({
          content:
            'For Discord role (other server), provide `source_guild_id` and `source_role_id`. The bot must be in the source guild. Get IDs from Server Settings → right-click role/copy ID (Developer Mode on).',
        });
        return;
      }
      const result = await convex.mutation(api.role_rules.addProductFromDiscordRole as any, {
        apiSecret,
        tenantId: ctx.tenantId,
        sourceGuildId: sourceGuildId.trim(),
        requiredRoleId: sourceRoleId.trim(),
        guildId: ctx.guildId,
        guildLinkId: ctx.guildLinkId,
        verifiedRoleId: role.id,
      });
      productId = result.productId;
      const ruleId = result.ruleId;
      track(interaction.user.id, 'product_added', {
        tenantId: ctx.tenantId,
        guildId: ctx.guildId,
        productId,
        ruleId,
      });
      await interaction.editReply({
        content: `Discord role rule added: users with <@&${sourceRoleId}> in the source server get ${role.name}. Product ID: \`${productId}\``,
      });
      return;
    } else {
      await interaction.editReply({ content: 'Unknown source type.' });
      return;
    }

    const { ruleId } = await convex.mutation(api.role_rules.createRoleRule as any, {
      apiSecret,
      tenantId: ctx.tenantId,
      guildId: ctx.guildId,
      guildLinkId: ctx.guildLinkId,
      productId,
      catalogProductId,
      verifiedRoleId: role.id,
    });

    track(interaction.user.id, 'product_added', {
      tenantId: ctx.tenantId,
      guildId: ctx.guildId,
      productId,
      ruleId,
    });

    await interaction.editReply({
      content: `Product **${productId}** linked to role ${role.name}. Rule ID: \`${ruleId}\``,
    });
  } catch (err) {
    await interaction.editReply({
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export async function handleProductList(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rules = await convex.query(api.role_rules.getByGuild as any, {
    tenantId: ctx.tenantId,
    guildId: ctx.guildId,
  });

  if (!rules.length) {
    await interaction.editReply({
      content: 'No product-role mappings for this server.',
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Product-Role Mappings')
    .setColor(0x5865f2)
    .setDescription(
      rules
        .map(
          (r: { productId: string; verifiedRoleId: string; enabled: boolean }) =>
            `• \`${r.productId}\` → <@&${r.verifiedRoleId}> ${r.enabled ? '✓' : '(disabled)'}`,
        )
        .join('\n'),
    );

  await interaction.editReply({ embeds: [embed] });
}

export async function handleProductRemove(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  _ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  const productId = interaction.options.getString('product_id', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rules = await convex.query(api.role_rules.getByTenant as any, {
    tenantId: _ctx.tenantId,
  });
  const matching = rules.filter((r: { productId: string }) => r.productId === productId);

  if (!matching.length) {
    await interaction.editReply({
      content: `No rule found for product \`${productId}\`.`,
    });
    return;
  }

  for (const rule of matching) {
    await convex.mutation(api.role_rules.deleteRoleRule as any, {
      apiSecret,
      ruleId: rule._id,
    });
  }

  await interaction.editReply({
    content: `Removed ${matching.length} rule(s) for product \`${productId}\`.`,
  });
}
