import { PROVIDER_REGISTRY, PROVIDER_REGISTRY_BY_KEY } from '@yucp/providers/providerMetadata';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder as DiscordEmbedBuilder,
  type EmbedBuilder,
} from 'discord.js';
import { E, Emoji } from './emojis';

const DEFAULT_SPAWN_TITLE = `${E.Assistant} Verify your creator access`;
const DEFAULT_SPAWN_BUTTON_TEXT = 'Start verification';
const DEFAULT_SPAWN_COLOR = 0x5865f2; // Discord Blurple
const SETUP_SPAWN_TITLE = `${E.Assistant} Verification setup in progress`;
const SETUP_SPAWN_BUTTON_TEXT = 'Setup in progress';
export const VERIFY_PROMPT_FOOTER_TEXT = 'Choose the option that matches how you got access.';

type EnabledProviderDescriptor = (typeof PROVIDER_REGISTRY)[number];
type EmojiKey = keyof typeof E;

export interface VerifyPromptOverrides {
  titleOverride?: string;
  descriptionOverride?: string;
  buttonTextOverride?: string;
  color?: number;
  imageUrl?: string;
}

export interface VerifyPromptPresentation {
  title: string;
  description: string;
  buttonText: string;
  buttonDisabled: boolean;
  color: number;
  imageUrl?: string;
}

export interface VerifyPromptAccessPreview {
  channelMentions: string[];
  moreChannelCount: number;
  lienedDownloadMentions: string[];
  moreLienedDownloadCount: number;
  discordSourceGuildMentions: string[];
  moreDiscordSourceGuildCount: number;
}

export function getEnabledProviders(result: unknown): string[] {
  if (
    typeof result === 'object' &&
    result !== null &&
    'providers' in result &&
    Array.isArray(result.providers)
  ) {
    return result.providers.filter((provider): provider is string => typeof provider === 'string');
  }

  return [];
}

function formatNaturalList(items: string[], conjunction: 'and' | 'or' = 'and'): string {
  const filtered = items.map((item) => item.trim()).filter(Boolean);
  if (filtered.length === 0) return '';
  if (filtered.length === 1) return filtered[0];
  if (filtered.length === 2) return `${filtered[0]} ${conjunction} ${filtered[1]}`;
  return `${filtered.slice(0, -1).join(', ')}, ${conjunction} ${filtered.at(-1)}`;
}

function formatPreviewList(items: string[], extraCount: number): string {
  if (items.length === 0) {
    return extraCount > 0 ? `${extraCount} places` : '';
  }
  if (extraCount <= 0) {
    return formatNaturalList(items, 'and');
  }
  return `${items.join(', ')}, and ${extraCount} more`;
}

function formatServerPreviewList(items: string[], extraCount: number): string {
  if (items.length === 0) {
    return extraCount > 0 ? `${extraCount} more linked server${extraCount === 1 ? '' : 's'}` : '';
  }
  if (extraCount <= 0) {
    return formatNaturalList(items, 'or');
  }
  return `${items.join(', ')}, or ${extraCount} more server${extraCount === 1 ? '' : 's'}`;
}

function getEnabledProviderDescriptors(enabledSet: Set<string>): EnabledProviderDescriptor[] {
  return [...enabledSet]
    .map((provider) => PROVIDER_REGISTRY_BY_KEY[provider as keyof typeof PROVIDER_REGISTRY_BY_KEY])
    .filter(
      (provider): provider is EnabledProviderDescriptor =>
        provider !== undefined && provider.status === 'active'
    );
}

function getEmojiText(emojiKey?: string): string | undefined {
  if (!emojiKey) return undefined;
  return Object.hasOwn(E, emojiKey) ? E[emojiKey as EmojiKey] : undefined;
}

function formatProviderMention(provider: EnabledProviderDescriptor): string {
  const emoji = getEmojiText(provider.emojiKey);
  return emoji ? `${emoji} ${provider.label}` : provider.label;
}

function formatProviderList(
  providers: EnabledProviderDescriptor[],
  conjunction: 'and' | 'or' = 'and'
): string {
  return formatNaturalList(
    providers.map((provider) => formatProviderMention(provider)),
    conjunction
  );
}

function getInstructionLeadEmoji(
  providers: EnabledProviderDescriptor[],
  fallbackEmoji: string
): string {
  if (providers.length !== 1) {
    return fallbackEmoji;
  }

  return getEmojiText(providers[0]?.emojiKey) ?? fallbackEmoji;
}

export function buildVerificationCoverage(enabledSet: Set<string>): string {
  const enabledProviders = getEnabledProviderDescriptors(enabledSet);
  const commerceProviders = enabledProviders.filter((provider) => provider.category === 'commerce');
  const coverage: string[] = [];

  if (commerceProviders.length > 0) {
    coverage.push(
      `purchases from ${formatNaturalList(
        commerceProviders.map((provider) => provider.label),
        'or'
      )}`
    );
  }
  if (enabledSet.has('vrchat')) {
    coverage.push('VRChat ownership');
  }
  if (enabledSet.has('discord')) {
    coverage.push('access from another Discord server');
  }

  return formatNaturalList(coverage, 'and');
}

function buildAccessSummaryLines(accessPreview?: VerifyPromptAccessPreview): string[] {
  if (!accessPreview) return [];

  const lines: string[] = [];
  const channelSummary = formatPreviewList(
    accessPreview.channelMentions,
    accessPreview.moreChannelCount
  );
  const lienedDownloadSummary = formatPreviewList(
    accessPreview.lienedDownloadMentions,
    accessPreview.moreLienedDownloadCount
  );

  if (channelSummary) {
    lines.push(`${E.Home} Verify to access ${channelSummary}!`);
  }
  if (lienedDownloadSummary) {
    lines.push(`${E.Library} Find your Liened Downloads in ${lienedDownloadSummary}.`);
  }

  return lines;
}

function buildProviderInstructionLines(
  enabledSet: Set<string>,
  accessPreview?: VerifyPromptAccessPreview
): string[] {
  const enabledProviders = getEnabledProviderDescriptors(enabledSet);
  const commerceOauthProviders = enabledProviders.filter(
    (provider) => provider.supportsOAuth && provider.category === 'commerce'
  );
  const licenseProviders = enabledProviders.filter((provider) => provider.supportsLicenseVerify);
  const lines: string[] = [];

  if (commerceOauthProviders.length > 0 && licenseProviders.length > 0) {
    const oauthLabels = commerceOauthProviders.map((provider) => provider.label);
    const licenseLabels = licenseProviders.map((provider) => provider.label);
    const licenseLabelSet = new Set<string>(licenseLabels);
    const oauthProviderText =
      commerceOauthProviders.length === 1
        ? (commerceOauthProviders[0]?.label ?? '')
        : formatProviderList(commerceOauthProviders, 'or');
    const licenseProviderText =
      licenseProviders.length === 1
        ? (licenseProviders[0]?.label ?? '')
        : formatProviderList(licenseProviders, 'or');
    const sameProviderSet =
      oauthLabels.length === licenseLabels.length &&
      oauthLabels.every((label) => licenseLabelSet.has(label));

    if (sameProviderSet) {
      lines.push(
        `${getInstructionLeadEmoji(commerceOauthProviders, E.Link)} Using ${oauthProviderText}? ${
          commerceOauthProviders.length === 1
            ? `Sign in with your ${oauthProviderText} account or paste your license key.`
            : 'Sign in with the store you used, or paste your license key.'
        }`
      );
    } else {
      lines.push(
        `${getInstructionLeadEmoji(commerceOauthProviders, E.Link)} Using ${oauthProviderText}? ${
          commerceOauthProviders.length === 1
            ? `Sign in with your ${oauthProviderText} account.`
            : 'Sign in with the store you used.'
        }`
      );
      lines.push(
        `${getInstructionLeadEmoji(licenseProviders, E.Key)} Using a ${licenseProviderText} license key? Paste it in to verify.`
      );
    }
  } else if (commerceOauthProviders.length > 0) {
    lines.push(
      `${getInstructionLeadEmoji(commerceOauthProviders, E.Link)} Using ${
        commerceOauthProviders.length === 1
          ? (commerceOauthProviders[0]?.label ?? '')
          : formatProviderList(commerceOauthProviders, 'or')
      }? ${
        commerceOauthProviders.length === 1
          ? `Sign in with your ${commerceOauthProviders[0]?.label} account.`
          : 'Sign in with the store you used.'
      }`
    );
  } else if (licenseProviders.length > 0) {
    lines.push(
      `${getInstructionLeadEmoji(licenseProviders, E.Key)} Using a ${
        licenseProviders.length === 1
          ? (licenseProviders[0]?.label ?? '')
          : formatProviderList(licenseProviders, 'or')
      } license key? Paste it in to verify.`
    );
  }

  if (enabledSet.has('discord')) {
    const sourceGuildSummary = formatServerPreviewList(
      accessPreview?.discordSourceGuildMentions ?? [],
      accessPreview?.moreDiscordSourceGuildCount ?? 0
    );
    lines.push(
      sourceGuildSummary
        ? `${E.Discord} Have you verified in ${sourceGuildSummary}? Bring your verification here! Sign in and sync your roles.`
        : `${E.Discord} Need to bring a verification from another server? Sign in and sync your roles.`
    );
  }
  if (enabledSet.has('vrchat')) {
    lines.push(`${E.VRC} Access from VRChat? Sign in with VRChat.`);
  }

  return lines;
}

function buildSpawnTitle(enabledSet: Set<string>): string {
  if (enabledSet.size === 0) {
    return SETUP_SPAWN_TITLE;
  }

  const enabledProviders = getEnabledProviderDescriptors(enabledSet);
  if (enabledProviders.length === 1) {
    const [provider] = enabledProviders;
    if (provider) {
      if (provider.providerKey === 'discord') return `${E.Assistant} Verify your server access`;
      if (provider.providerKey === 'vrchat') return `${E.Assistant} Verify your VRChat access`;
      return `${E.Assistant} Verify your ${provider.label} access`;
    }
  }

  return DEFAULT_SPAWN_TITLE;
}

function buildSpawnButtonText(enabledSet: Set<string>): string {
  if (enabledSet.size === 0) {
    return SETUP_SPAWN_BUTTON_TEXT;
  }

  const enabledProviders = getEnabledProviderDescriptors(enabledSet);
  if (enabledProviders.length === 1) {
    const [provider] = enabledProviders;
    if (provider) {
      if (provider.providerKey === 'discord') return 'Check server access';
      if (provider.providerKey === 'vrchat') return 'Verify with VRChat';
      if (provider.supportsLicenseVerify && !provider.supportsOAuth) return 'Enter license key';
      if (provider.supportsOAuth && !provider.supportsLicenseVerify) {
        return `Connect ${provider.label}`;
      }
      return `Verify ${provider.label}`;
    }
  }

  return DEFAULT_SPAWN_BUTTON_TEXT;
}

function buildSpawnDescription(
  enabledSet: Set<string>,
  buttonText: string,
  accessPreview?: VerifyPromptAccessPreview
): string {
  if (enabledSet.size === 0) {
    return [
      `${E.Wrench} This server is still being set up.`,
      '',
      'A creator or server admin needs to add at least one product before anyone can verify here.',
      'This message will update automatically when verification is ready.',
    ].join('\n');
  }

  const accessSummaryLines = buildAccessSummaryLines(accessPreview);
  const instructionLines = buildProviderInstructionLines(enabledSet, accessPreview);
  const benefitLine =
    accessSummaryLines.length > 0
      ? accessSummaryLines
      : [`${E.Home} Verify to access your channels, downloads, roles, and more!`];

  return [
    ...benefitLine,
    '',
    `${E.Touch} Click **${buttonText}** to choose your verification path.`,
    ...instructionLines,
    `${E.Checkmark} We’ll confirm it and update your roles automatically.`,
    '',
    `${E.Wrench} Need help? Ask a server admin if your purchase should be included here.`,
  ].join('\n');
}

function buildGenericSpawnDescription(
  buttonText: string,
  accessPreview?: VerifyPromptAccessPreview
): string {
  const accessSummaryLines = buildAccessSummaryLines(accessPreview);
  return [
    ...(accessSummaryLines.length > 0
      ? accessSummaryLines
      : [`${E.Home} Verify to access your channels, downloads, roles, and more!`]),
    '',
    `${E.Touch} Click **${buttonText}** to choose your verification path.`,
    `${E.Checkmark} We’ll confirm it and update your roles automatically.`,
    '',
    `${E.Wrench} Need help? Ask a server admin if your purchase should be included here.`,
  ].join('\n');
}

export function resolveVerifyPromptPresentation(
  enabledSet: Set<string>,
  overrides?: VerifyPromptOverrides,
  options?: {
    useGenericFallbackCopy?: boolean;
    accessPreview?: VerifyPromptAccessPreview;
  }
): VerifyPromptPresentation {
  const useGenericFallbackCopy = options?.useGenericFallbackCopy ?? false;
  const buttonText =
    overrides?.buttonTextOverride ??
    (useGenericFallbackCopy ? DEFAULT_SPAWN_BUTTON_TEXT : buildSpawnButtonText(enabledSet));
  const title =
    overrides?.titleOverride ??
    (useGenericFallbackCopy ? DEFAULT_SPAWN_TITLE : buildSpawnTitle(enabledSet));
  const description =
    overrides?.descriptionOverride ??
    (useGenericFallbackCopy
      ? buildGenericSpawnDescription(buttonText, options?.accessPreview)
      : buildSpawnDescription(enabledSet, buttonText, options?.accessPreview));

  return {
    title,
    description,
    buttonText,
    buttonDisabled: !useGenericFallbackCopy && enabledSet.size === 0,
    color: overrides?.color ?? DEFAULT_SPAWN_COLOR,
    imageUrl: overrides?.imageUrl,
  };
}

export function buildVerifyPromptMessage(
  enabledSet: Set<string>,
  overrides?: VerifyPromptOverrides,
  options?: {
    useGenericFallbackCopy?: boolean;
    accessPreview?: VerifyPromptAccessPreview;
  }
): {
  embed: EmbedBuilder;
  row: ActionRowBuilder<ButtonBuilder>;
  presentation: VerifyPromptPresentation;
} {
  const presentation = resolveVerifyPromptPresentation(enabledSet, overrides, options);
  const embed = new DiscordEmbedBuilder()
    .setTitle(presentation.title)
    .setDescription(presentation.description)
    .setColor(presentation.color)
    .setFooter({ text: VERIFY_PROMPT_FOOTER_TEXT });

  if (presentation.imageUrl) {
    embed.setImage(presentation.imageUrl);
  }

  const button = new ButtonBuilder()
    .setCustomId('verify_start')
    .setLabel(presentation.buttonText)
    .setEmoji(Emoji.PersonKey)
    .setStyle(presentation.buttonDisabled ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setDisabled(presentation.buttonDisabled);

  return {
    embed,
    row: new ActionRowBuilder<ButtonBuilder>().addComponents(button),
    presentation,
  };
}
