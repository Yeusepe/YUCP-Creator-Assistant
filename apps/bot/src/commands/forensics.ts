import { createLogger, getInternalRpcSharedSecret } from '@yucp/shared';
import type { ConvexHttpClient } from 'convex/browser';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { escapeMarkdown, MessageFlags } from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import { getApiUrls } from '../lib/apiUrls';
import { E } from '../lib/emojis';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;
const NO_ALLOWED_MENTIONS = { parse: [] } as const;

const FORENSICS_JOB_POLL_INTERVAL_MS = 5_000;
/** Above the API's scan budget plus reveal budget, with margin for queueing. */
const FORENSICS_JOB_POLL_DEADLINE_MS = 10 * 60_000;
/** Transient poll failures a scan is allowed to ride out before giving up. */
const FORENSICS_JOB_POLL_MAX_CONSECUTIVE_FAILURES = 3;

type ForensicsScanPage = {
  buyersCompared: number;
  elapsedMs: number;
  page: number;
  resolved: number;
  unresolvedAfter: number;
};

type ForensicsJobStatus =
  | { state: 'running'; progress: { elapsedMs: number; pages: ForensicsScanPage[] } }
  | { state: 'done'; httpStatus: number; result: unknown };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ForensicsLookupResponse = {
  packageId: string;
  lookupStatus:
    | 'attributed'
    | 'tampered_suspected'
    | 'hostile_unknown'
    | 'no_signal_found'
    | 'no_candidate_assets';
  message: string;
  candidateAssetCount: number;
  decodedAssetCount: number;
  results: Array<{
    assetPath: string;
    assetType: 'png' | 'fbx';
    decoderKind: string;
    tokenLength: number;
    matched: boolean;
    layerBClassification:
      | 'trace-recovered'
      | 'tamper-suspected'
      | 'trace-likely-stripped'
      | 'no-signal-found';
    matches: Array<{
      matchId: string;
      buyerMatchId?: string | null;
      assetPath: string;
      createdAt: number;
      runtimeArtifactVersion?: string | null;
      licenseMasked?: string | null;
      buyerProviderUsername?: string | null;
      buyerSubjectDisplayName?: string | null;
    }>;
  }>;
};

function buildDashboardForensicsUrl(): string | null {
  const { webPublic, apiPublic } = getApiUrls();
  const baseUrl = webPublic ?? apiPublic;
  if (!baseUrl) {
    return null;
  }
  return new URL('/dashboard/packages?view=forensics', baseUrl).toString();
}

function sanitizeUploadFileName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return 'forensics-upload.bin';
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function escapeDiscordText(input: string): string {
  return escapeMarkdown(input.replace(/[\r\n]+/g, ' ').replace(/`/g, "'")).replace(/@/g, '@\u200b');
}

function formatDiscordInlineCode(input: string): string {
  return `\`${escapeDiscordText(input)}\``;
}

function formatCreatedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

type ForensicsLookupMatch = ForensicsLookupResponse['results'][number]['matches'][number];

function getForensicsMatchIdentity(match: ForensicsLookupMatch): string {
  return match.buyerMatchId?.trim() || match.matchId;
}

function formatForensicsMatchLabel(match: ForensicsLookupMatch): string {
  const buyerLabel = match.buyerSubjectDisplayName?.trim() || match.buyerProviderUsername?.trim();
  const licenseLabel = match.licenseMasked?.trim();
  if (buyerLabel && licenseLabel) {
    return `${buyerLabel} (${licenseLabel})`;
  }
  return buyerLabel || licenseLabel || `match ${getForensicsMatchIdentity(match).slice(0, 12)}`;
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
    .filter((packageId: string) => !query || packageId.toLowerCase().includes(query))
    .slice(0, 25)
    .map((packageId: string) => ({
      name: packageId.slice(0, 100),
      value: packageId.slice(0, 100),
    }));

  await interaction.respond(choices);
}

export async function handleForensicsLookup(
  interaction: ChatInputCommandInteraction,
  ctx: { authUserId: string; guildId: string },
  opts?: { pollIntervalMs?: number }
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const packageId = interaction.options.getString('package_id', true).trim();
  const attachment = interaction.options.getAttachment('file', true);
  const dashboardUrl = buildDashboardForensicsUrl();

  if (attachment.size > MAX_UPLOAD_SIZE_BYTES) {
    await interaction.editReply({
      content: `${E.Library} This upload is larger than the current limit. Use the dashboard upload instead${dashboardUrl ? `: ${dashboardUrl}` : '.'}`,
      allowedMentions: NO_ALLOWED_MENTIONS,
    });
    return;
  }

  const { apiInternal, apiPublic } = getApiUrls();
  const apiBase = (apiInternal ?? apiPublic ?? '').replace(/\/$/, '');
  if (!apiBase) {
    await interaction.editReply({
      content: `${E.X_} The API URL is not configured for coupling lookups right now.`,
      allowedMentions: NO_ALLOWED_MENTIONS,
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

    const authHeaders = {
      'x-internal-service-secret': getInternalRpcSharedSecret(process.env),
      'x-yucp-auth-user-id': ctx.authUserId,
    };

    // A scan of a large buyer catalogue runs for minutes - longer than a
    // single HTTP request survives. Start a server-side job and poll for the
    // verdict, editing the deferred reply as scan pages come in.
    const startResponse = await fetch(`${apiBase}/api/forensics/lookup/jobs`, {
      method: 'POST',
      headers: authHeaders,
      body: formData,
    });
    const startPayload = (await startResponse.json().catch(() => null)) as {
      jobId?: string;
      error?: string;
    } | null;
    if (!startResponse.ok || !startPayload?.jobId) {
      const message =
        startPayload && typeof startPayload.error === 'string'
          ? startPayload.error
          : 'Coupling lookup failed.';
      await interaction.editReply({
        content: `${E.X_} ${message}${dashboardUrl ? `\n\nIf this keeps happening, try the dashboard uploader: ${dashboardUrl}` : ''}`,
        allowedMentions: NO_ALLOWED_MENTIONS,
      });
      return;
    }

    const pollIntervalMs = opts?.pollIntervalMs ?? FORENSICS_JOB_POLL_INTERVAL_MS;
    const deadline = Date.now() + FORENSICS_JOB_POLL_DEADLINE_MS;
    let consecutiveFailures = 0;
    let lastReportedPage = 0;
    let final: { httpStatus: number; body: unknown } | null = null;
    while (!final) {
      await sleep(pollIntervalMs);
      if (Date.now() > deadline) {
        await interaction.editReply({
          content: `${E.Timer} The scan did not finish in time.${dashboardUrl ? ` Try the dashboard uploader instead: ${dashboardUrl}` : ''}`,
          allowedMentions: NO_ALLOWED_MENTIONS,
        });
        return;
      }
      let status: ForensicsJobStatus;
      try {
        const pollResponse = await fetch(
          `${apiBase}/api/forensics/lookup/jobs/${startPayload.jobId}`,
          { headers: authHeaders }
        );
        if (!pollResponse.ok) {
          throw new Error(`Job poll failed with status ${pollResponse.status}`);
        }
        status = (await pollResponse.json()) as ForensicsJobStatus;
        consecutiveFailures = 0;
      } catch (error) {
        // One dropped poll must not discard a scan that is still running.
        consecutiveFailures += 1;
        if (consecutiveFailures >= FORENSICS_JOB_POLL_MAX_CONSECUTIVE_FAILURES) {
          throw error;
        }
        continue;
      }
      if (status.state === 'running') {
        const latestPage = status.progress.pages.at(-1);
        if (latestPage && latestPage.page > lastReportedPage) {
          lastReportedPage = latestPage.page;
          const elapsedSeconds = Math.round(latestPage.elapsedMs / 1000);
          await interaction
            .editReply({
              content: `${E.Timer} Scanning ${formatDiscordInlineCode(packageId)}... page ${latestPage.page}: ${latestPage.buyersCompared} buyers compared, ${latestPage.resolved} resolved (${elapsedSeconds}s elapsed)`,
              allowedMentions: NO_ALLOWED_MENTIONS,
            })
            .catch(() => {
              // A dropped progress edit must not abort a scan that is still running.
            });
        }
        continue;
      }
      final = { httpStatus: status.httpStatus, body: status.result };
    }

    const payload = final.body as
      | (ForensicsLookupResponse & { error?: string; code?: string })
      | null;

    if (final.httpStatus === 402 || payload?.code === 'coupling_traceability_required') {
      await interaction.editReply({
        content: `${E.Key} Creator Studio+ is required for coupling traceability.${dashboardUrl ? ` Upgrade or run the lookup from the dashboard: ${dashboardUrl}` : ''}`,
        allowedMentions: NO_ALLOWED_MENTIONS,
      });
      return;
    }

    if (final.httpStatus < 200 || final.httpStatus >= 300 || !payload) {
      const message =
        payload && typeof payload.error === 'string' ? payload.error : 'Coupling lookup failed.';
      await interaction.editReply({
        content: `${E.X_} ${message}${dashboardUrl ? `\n\nIf this keeps happening, try the dashboard uploader: ${dashboardUrl}` : ''}`,
        allowedMentions: NO_ALLOWED_MENTIONS,
      });
      return;
    }

    const matchedEntries = payload.results.filter((entry) => entry.matched);
    const uniqueBuyerMatches = new Set<string>();
    const shownBuyerMatches = new Set<string>();
    const detailLines: string[] = [];

    for (const entry of matchedEntries) {
      for (const match of entry.matches) {
        const matchIdentity = getForensicsMatchIdentity(match);
        uniqueBuyerMatches.add(matchIdentity);
        if (detailLines.length >= 5 || shownBuyerMatches.has(matchIdentity)) {
          continue;
        }
        shownBuyerMatches.add(matchIdentity);
        const matchLabel = formatForensicsMatchLabel(match);
        detailLines.push(
          `- ${formatDiscordInlineCode(entry.assetPath)} -> ${formatDiscordInlineCode(matchLabel)} (${formatCreatedAt(match.createdAt)})`
        );
      }
    }

    const remainingBuyerCount = Math.max(0, uniqueBuyerMatches.size - shownBuyerMatches.size);

    const content = [
      matchedEntries.length > 0
        ? `${E.Checkmark} Coupling lookup complete`
        : `${E.Library} Coupling lookup complete`,
      `Package: ${formatDiscordInlineCode(payload.packageId)}`,
      `File: ${formatDiscordInlineCode(attachment.name ?? 'upload')}`,
      `Status: ${payload.lookupStatus.replace(/_/g, ' ')}`,
      `Candidates scanned: ${payload.candidateAssetCount}`,
      `Decoded assets: ${payload.decodedAssetCount}`,
      `Matched assets: ${matchedEntries.length}`,
      matchedEntries.length > 0 ? `Matched buyers: ${uniqueBuyerMatches.size}` : payload.message,
      detailLines.length > 0 ? '' : null,
      ...(detailLines.length > 0 ? ['Top matches:', ...detailLines] : []),
      remainingBuyerCount > 0
        ? `Use the dashboard for the remaining ${remainingBuyerCount} matched buyer${remainingBuyerCount === 1 ? '' : 's'}${dashboardUrl ? `: ${dashboardUrl}` : '.'}`
        : dashboardUrl
          ? `Dashboard: ${dashboardUrl}`
          : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');

    await interaction.editReply({ content, allowedMentions: NO_ALLOWED_MENTIONS });
  } catch (error) {
    logger.error('Coupling forensics lookup command failed', {
      error: error instanceof Error ? error.message : String(error),
      guildId: ctx.guildId,
      authUserId: ctx.authUserId,
    });

    await interaction.editReply({
      content: `${E.X_} Coupling lookup failed.${dashboardUrl ? ` Try the dashboard uploader instead: ${dashboardUrl}` : ''}`,
      allowedMentions: NO_ALLOWED_MENTIONS,
    });
  }
}
