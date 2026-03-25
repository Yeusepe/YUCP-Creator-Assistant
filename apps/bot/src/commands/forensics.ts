import { createLogger, getInternalRpcSharedSecret } from '@yucp/shared';
import type { ConvexHttpClient } from 'convex/browser';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import { getApiUrls } from '../lib/apiUrls';
import { E } from '../lib/emojis';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;

type ForensicsLookupResponse = {
  packageId: string;
  message: string;
  candidateAssetCount: number;
  decodedAssetCount: number;
  results: Array<{
    assetPath: string;
    assetType: 'png' | 'fbx';
    decoderKind: string;
    tokenLength: number;
    matched: boolean;
    matches: Array<{
      licenseSubject: string;
      assetPath: string;
      correlationId: string | null;
      createdAt: number;
      runtimeArtifactVersion?: string | null;
    }>;
  }>;
};

function buildDashboardForensicsUrl(): string | null {
  const { webPublic, apiPublic } = getApiUrls();
  const baseUrl = webPublic ?? apiPublic;
  if (!baseUrl) {
    return null;
  }
  return new URL('/dashboard/forensics', baseUrl).toString();
}

function sanitizeUploadFileName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return 'forensics-upload.bin';
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function formatCreatedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export async function handleForensicsPackageAutocomplete(
  interaction: AutocompleteInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  authUserId: string
): Promise<void> {
  const query = interaction.options.getFocused().toLowerCase();
  const result = await convex.query(api.couplingForensics.listOwnedPackagesForAuthUser, {
    apiSecret,
    authUserId,
  });

  const choices = result.packages
    .filter((packageId) => !query || packageId.toLowerCase().includes(query))
    .slice(0, 25)
    .map((packageId) => ({
      name: packageId.slice(0, 100),
      value: packageId.slice(0, 100),
    }));

  await interaction.respond(choices);
}

export async function handleForensicsLookup(
  interaction: ChatInputCommandInteraction,
  ctx: { authUserId: string; guildId: string }
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const packageId = interaction.options.getString('package_id', true).trim();
  const attachment = interaction.options.getAttachment('file', true);
  const dashboardUrl = buildDashboardForensicsUrl();

  if (attachment.size > MAX_UPLOAD_SIZE_BYTES) {
    await interaction.editReply({
      content: `${E.Library} This upload is larger than the current limit. Use the dashboard upload instead${dashboardUrl ? `: ${dashboardUrl}` : '.'}`,
    });
    return;
  }

  const { apiInternal, apiPublic } = getApiUrls();
  const apiBase = (apiInternal ?? apiPublic ?? '').replace(/\/$/, '');
  if (!apiBase) {
    await interaction.editReply({
      content: `${E.X_} The API URL is not configured for coupling lookups right now.`,
    });
    return;
  }

  try {
    const attachmentResponse = await fetch(attachment.url);
    if (!attachmentResponse.ok) {
      throw new Error(`Attachment download failed with status ${attachmentResponse.status}`);
    }

    const uploadBytes = new Uint8Array(await attachmentResponse.arrayBuffer());
    const formData = new FormData();
    formData.set('packageId', packageId);
    formData.set(
      'file',
      new File([uploadBytes], sanitizeUploadFileName(attachment.name ?? 'forensics-upload.bin'), {
        type: attachment.contentType ?? 'application/octet-stream',
      })
    );

    const response = await fetch(`${apiBase}/api/forensics/lookup`, {
      method: 'POST',
      headers: {
        'x-internal-service-secret': getInternalRpcSharedSecret(process.env),
        'x-yucp-auth-user-id': ctx.authUserId,
      },
      body: formData,
    });

    const payload = (await response.json().catch(() => null)) as
      | (ForensicsLookupResponse & { error?: string; code?: string })
      | null;

    if (response.status === 402 || payload?.code === 'coupling_traceability_required') {
      await interaction.editReply({
        content: `${E.Key} Creator Studio+ is required for coupling traceability.${dashboardUrl ? ` Upgrade or run the lookup from the dashboard: ${dashboardUrl}` : ''}`,
      });
      return;
    }

    if (!response.ok || !payload) {
      const message =
        payload && typeof payload.error === 'string' ? payload.error : 'Coupling lookup failed.';
      await interaction.editReply({
        content: `${E.X_} ${message}${dashboardUrl ? `\n\nIf this keeps happening, try the dashboard uploader: ${dashboardUrl}` : ''}`,
      });
      return;
    }

    const matchedEntries = payload.results.filter((entry) => entry.matched);
    const uniqueLicenseSubjects = new Set<string>();
    const detailLines: string[] = [];

    for (const entry of matchedEntries.slice(0, 5)) {
      const primaryMatch = entry.matches[0];
      if (!primaryMatch) {
        continue;
      }
      uniqueLicenseSubjects.add(primaryMatch.licenseSubject);
      detailLines.push(
        `- \`${entry.assetPath}\` -> \`${primaryMatch.licenseSubject}\` (${formatCreatedAt(primaryMatch.createdAt)})`
      );
    }

    const remainingMatchCount = Math.max(0, matchedEntries.length - detailLines.length);

    const content = [
      matchedEntries.length > 0
        ? `${E.Checkmark} Coupling lookup complete`
        : `${E.Library} Coupling lookup complete`,
      `Package: \`${payload.packageId}\``,
      `File: \`${attachment.name ?? 'upload'}\``,
      `Candidates scanned: ${payload.candidateAssetCount}`,
      `Decoded assets: ${payload.decodedAssetCount}`,
      `Matched assets: ${matchedEntries.length}`,
      matchedEntries.length > 0
        ? `Matched licenses: ${uniqueLicenseSubjects.size}`
        : payload.message,
      detailLines.length > 0 ? '' : null,
      ...(detailLines.length > 0 ? ['Top matches:', ...detailLines] : []),
      remainingMatchCount > 0
        ? `Use the dashboard for the remaining ${remainingMatchCount} matched asset${remainingMatchCount === 1 ? '' : 's'}${dashboardUrl ? `: ${dashboardUrl}` : '.'}`
        : dashboardUrl
          ? `Dashboard: ${dashboardUrl}`
          : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');

    await interaction.editReply({ content });
  } catch (error) {
    logger.error('Coupling forensics lookup command failed', {
      error: error instanceof Error ? error.message : String(error),
      guildId: ctx.guildId,
      authUserId: ctx.authUserId,
    });

    await interaction.editReply({
      content: `${E.X_} Coupling lookup failed.${dashboardUrl ? ` Try the dashboard uploader instead: ${dashboardUrl}` : ''}`,
    });
  }
}
