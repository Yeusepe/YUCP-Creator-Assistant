import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getInternalRpcSharedSecret, timingSafeStringEqual } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import type { Auth } from '../auth';
import { getConvexClientFromUrl } from '../lib/convex';
import { extractCouplingForensicsArchive } from '../lib/couplingForensicsArchives';
import {
  CouplingServiceConfigurationError,
  CouplingServiceRequestError,
  type ForensicsScoreResult,
  runCouplingForensicsScore,
} from '../lib/couplingForensicsService';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import { getProviderRuntime } from '../providers/index';
import { decryptForensicsLicenseKey } from '../verification/forensicsLicenseKey';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_FILENAME_LENGTH = 128;

export type ForensicsConfig = {
  apiBaseUrl: string;
  couplingServiceBaseUrl: string;
  couplingServiceSharedSecret: string;
  frontendBaseUrl: string;
  convexApiSecret: string;
  convexUrl: string;
  encryptionSecret: string;
};

type ForensicsViewer = {
  authUserId: string;
  source: 'dashboard' | 'discord';
};

type ForensicsLookupStatus =
  | 'attributed'
  | 'tampered_suspected'
  | 'hostile_unknown'
  | 'no_candidate_assets';

type LayerBClassification =
  | 'trace-recovered'
  | 'tamper-suspected'
  | 'trace-likely-stripped'
  | 'unsupported-transform'
  | 'no-signal-found';

function buildLookupMessage(status: ForensicsLookupStatus): string {
  switch (status) {
    case 'attributed':
      return 'Authorized matches found';
    case 'tampered_suspected':
      return 'Candidate assets were found, but no valid coupling signals could be decoded';
    case 'hostile_unknown':
      return 'The uploaded archive did not resolve to an authorized trace record';
    case 'no_candidate_assets':
      return 'No coupling candidate assets were found';
  }
}

function buildAuditStatus(
  status: ForensicsLookupStatus
): 'matched' | 'attributed' | 'tampered_suspected' | 'hostile_unknown' | 'no_candidate_assets' {
  switch (status) {
    case 'attributed':
      return 'attributed';
    case 'tampered_suspected':
      return 'tampered_suspected';
    case 'hostile_unknown':
      return 'hostile_unknown';
    case 'no_candidate_assets':
      return 'no_candidate_assets';
  }
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function getAllowedOrigins(config: ForensicsConfig): Set<string> {
  return new Set([new URL(config.apiBaseUrl).origin, new URL(config.frontendBaseUrl).origin]);
}

function assertPackageId(packageId: string): string {
  const normalized = packageId.trim();
  if (!PACKAGE_ID_RE.test(normalized)) {
    throw new Error('Invalid packageId format');
  }
  return normalized;
}

function sanitizeUploadFilename(name: string): string {
  const basename = path.basename(name.replaceAll('\\', '/'));
  const sanitized = Array.from(basename)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim();
  if (!sanitized) {
    return 'upload.bin';
  }
  return sanitized.slice(-MAX_UPLOAD_FILENAME_LENGTH);
}

function resolveWorkspaceUploadPath(workspaceDir: string, uploadName: string): string {
  const workspaceRoot = path.resolve(workspaceDir);
  const candidate = path.resolve(workspaceRoot, uploadName);
  if (candidate === workspaceRoot || !candidate.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error('Invalid upload filename');
  }
  return candidate;
}

function getAllowedInternalSecrets(): string[] {
  const secrets = new Set<string>();
  const legacySecret = process.env.INTERNAL_SERVICE_AUTH_SECRET?.trim();
  if (legacySecret) {
    secrets.add(legacySecret);
  }
  try {
    secrets.add(getInternalRpcSharedSecret(process.env));
  } catch {}
  return [...secrets];
}

async function resolveViewer(
  request: Request,
  auth: Auth,
  config: ForensicsConfig
): Promise<ForensicsViewer | Response> {
  const internalSecrets = getAllowedInternalSecrets();
  const headerSecret = request.headers.get('x-internal-service-secret')?.trim() || '';
  const authHeader = request.headers.get('authorization')?.trim() || '';
  const internalAuthUserId = request.headers.get('x-yucp-auth-user-id')?.trim() || '';
  if (headerSecret) {
    if (!internalSecrets.some((secret) => timingSafeStringEqual(headerSecret, secret))) {
      return jsonResponse({ error: 'Forbidden' }, 403);
    }
    if (internalAuthUserId) {
      return { authUserId: internalAuthUserId, source: 'discord' };
    }
  }
  if (
    internalSecrets.length > 0 &&
    authHeader.startsWith('Bearer ') &&
    !internalSecrets.some((secret) => timingSafeStringEqual(authHeader, `Bearer ${secret}`))
  ) {
    if (authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Forbidden' }, 403);
    }
  }
  if (internalSecrets.length > 0 && authHeader.startsWith('Bearer ')) {
    if (!internalAuthUserId) {
      return jsonResponse({ error: 'Missing x-yucp-auth-user-id header' }, 400);
    }
    return { authUserId: internalAuthUserId, source: 'discord' };
  }

  const csrfBlock = rejectCrossSiteRequest(request, getAllowedOrigins(config));
  if (csrfBlock) {
    return csrfBlock;
  }

  const session = await auth.getSession(request);
  if (!session) {
    return jsonResponse({ error: 'Authentication required' }, 401);
  }
  return {
    authUserId: session.user.id,
    source: 'dashboard',
  };
}

function sha256HexFromBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeDeclaredPackageIds(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort(
    (left, right) => left.localeCompare(right)
  );
}

function classifyLayerB(
  scoreResult: ForensicsScoreResult,
  matchedTokenHashes: Set<string>
): LayerBClassification {
  if (scoreResult.preclassification === 'decoded') {
    if (!scoreResult.tokenHex) {
      return 'no-signal-found';
    }
    const tokenHash = sha256HexFromBytes(new TextEncoder().encode(scoreResult.tokenHex));
    return matchedTokenHashes.has(tokenHash) ? 'trace-recovered' : 'tamper-suspected';
  }
  if (scoreResult.preclassification === 'likely-stripped') {
    return 'trace-likely-stripped';
  }
  return 'no-signal-found';
}

type InvestigationReport = {
  totalAssets: number;
  decodedCount: number;
  attributedCount: number;
  unattributedCount: number;
  strippedCount: number;
  noSignalCount: number;
  topCandidates: Array<{
    licenseSubject: string;
    assetCount: number;
  }>;
};

function buildInvestigationReport(
  results: Array<{
    layerBClassification: LayerBClassification;
    matches: Array<{ licenseSubject: string }>;
  }>,
  totalAssets: number
): InvestigationReport {
  let decodedCount = 0;
  let attributedCount = 0;
  let unattributedCount = 0;
  let strippedCount = 0;
  let noSignalCount = 0;

  const candidateCounts = new Map<string, number>();

  for (const result of results) {
    switch (result.layerBClassification) {
      case 'trace-recovered':
        decodedCount++;
        attributedCount++;
        for (const match of result.matches) {
          candidateCounts.set(
            match.licenseSubject,
            (candidateCounts.get(match.licenseSubject) ?? 0) + 1
          );
        }
        break;
      case 'tamper-suspected':
        decodedCount++;
        unattributedCount++;
        break;
      case 'trace-likely-stripped':
        strippedCount++;
        break;
      default:
        noSignalCount++;
        break;
    }
  }

  const topCandidates = Array.from(candidateCounts.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([licenseSubject, assetCount]) => ({ licenseSubject, assetCount }));

  return {
    totalAssets,
    decodedCount,
    attributedCount,
    unattributedCount,
    strippedCount,
    noSignalCount,
    topCandidates,
  };
}

export function createForensicsRoutes(auth: Auth, config: ForensicsConfig) {
  const convex = getConvexClientFromUrl(config.convexUrl);

  async function enrichTraceMatches(
    viewer: ForensicsViewer,
    matches: Array<{
      tokenHash: string;
      licenseSubject: string;
      assetPath: string;
      correlationId: string;
      createdAt: number;
      runtimeArtifactVersion: string;
      runtimePlaintextSha256: string;
      machineFingerprintHash: string;
      projectIdHash: string;
      grantId?: string;
      packFamily?: string;
      packVersion?: string;
      provider?: string;
      licenseKeyEncrypted?: string;
      providerProductId?: string;
      buyerProviderUserId?: string;
      buyerProviderUsername?: string;
      buyerSubjectDisplayName?: string;
      buyerSubjectDiscordUserId?: string;
    }>
  ) {
    const identityCache = new Map<
      string,
      Promise<{
        buyerProviderUserId?: string;
        buyerProviderUsername?: string;
        buyerSubjectDisplayName?: string;
        buyerSubjectDiscordUserId?: string;
      } | null>
    >();

    return await Promise.all(
      matches.map(async (match) => {
        if (
          match.buyerProviderUsername ||
          match.buyerSubjectDisplayName ||
          match.buyerSubjectDiscordUserId ||
          !match.provider ||
          !match.licenseKeyEncrypted
        ) {
          return match;
        }

        const cacheKey = `${match.provider}:${match.licenseSubject}`;
        let pending = identityCache.get(cacheKey);
        if (!pending) {
          pending = (async () => {
            const verification = getProviderRuntime(match.provider ?? '')?.verification;
            if (!verification) {
              return null;
            }

            const licenseKey = await decryptForensicsLicenseKey(
              match.licenseKeyEncrypted as string,
              config.encryptionSecret
            );
            const verified = await verification.verifyLicense(
              licenseKey,
              match.providerProductId,
              viewer.authUserId,
              {
                convex,
                apiSecret: config.convexApiSecret,
                authUserId: viewer.authUserId,
                encryptionSecret: config.encryptionSecret,
              }
            );

            if (!verified?.valid) {
              return {};
            }

            const resolved = await convex.query(
              api.couplingForensics.resolveBuyerIdentityForAuthUser,
              {
                apiSecret: config.convexApiSecret,
                authUserId: viewer.authUserId,
                provider: match.provider as string,
                providerUserId: verified.providerUserId,
                externalOrderId: verified.externalOrderId,
              }
            );

            return {
              buyerProviderUserId: resolved?.buyerProviderUserId ?? verified.providerUserId,
              buyerProviderUsername: resolved?.buyerProviderUsername,
              buyerSubjectDisplayName: resolved?.buyerSubjectDisplayName,
              buyerSubjectDiscordUserId: resolved?.buyerSubjectDiscordUserId,
            };
          })();
          identityCache.set(cacheKey, pending);
        }

        const resolved = await pending;
        return resolved ? { ...match, ...resolved } : match;
      })
    );
  }

  async function listPackages(request: Request): Promise<Response> {
    const viewer = await resolveViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }

    try {
      const result = await convex.query(
        api.couplingForensics.listOwnedPackageSummariesForAuthUser,
        {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
        }
      );
      return jsonResponse(result);
    } catch (error) {
      logger.error('Failed to list owned coupling forensics packages', {
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to load packages' }, 500);
    }
  }

  async function lookup(request: Request): Promise<Response> {
    const viewer = await resolveViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const workspaceDir = await mkdtemp(path.join(tmpdir(), 'yucp-forensics-'));
    let auditContext: {
      authUserId: string;
      packageId: string;
      source: ForensicsViewer['source'];
      uploadSha256?: string;
    } | null = null;
    try {
      const formData = await request.formData();
      const packageId = assertPackageId(String(formData.get('packageId') ?? ''));
      const upload = formData.get('file');
      if (!(upload instanceof File)) {
        return jsonResponse({ error: 'Missing upload file' }, 400);
      }
      if (upload.size <= 0) {
        return jsonResponse({ error: 'Upload is empty' }, 400);
      }
      if (upload.size > MAX_UPLOAD_SIZE_BYTES) {
        return jsonResponse({ error: 'Upload exceeds the size limit' }, 413);
      }

      const uploadBytes = new Uint8Array(await upload.arrayBuffer());
      const uploadSha256 = sha256HexFromBytes(uploadBytes);
      auditContext = {
        authUserId: viewer.authUserId,
        packageId,
        source: viewer.source,
        uploadSha256,
      };
      const uploadName = sanitizeUploadFilename(upload.name || 'upload.bin');
      const uploadPath = resolveWorkspaceUploadPath(workspaceDir, uploadName);
      await Bun.write(uploadPath, uploadBytes);

      const extraction = await extractCouplingForensicsArchive(
        uploadPath,
        uploadName,
        workspaceDir
      );
      const declaredPackageIds = normalizeDeclaredPackageIds(extraction.declaredPackageIds);
      if (declaredPackageIds.length > 0 && !declaredPackageIds.includes(packageId)) {
        await convex.mutation(api.couplingForensics.recordLookupAudit, {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
          packageId,
          source: viewer.source,
          status: 'denied',
          requestedTokenCount: 0,
          matchedTokenCount: 0,
          uploadSha256,
        });
        return jsonResponse({
          packageId,
          lookupStatus: 'hostile_unknown' satisfies ForensicsLookupStatus,
          message: buildLookupMessage('hostile_unknown'),
          candidateAssetCount: extraction.assets.length,
          decodedAssetCount: 0,
          results: [],
        });
      }

      if (extraction.assets.length === 0) {
        const lookupStatus: ForensicsLookupStatus = 'no_candidate_assets';
        await convex.mutation(api.couplingForensics.recordLookupAudit, {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
          packageId,
          source: viewer.source,
          status: buildAuditStatus(lookupStatus),
          requestedTokenCount: 0,
          matchedTokenCount: 0,
          uploadSha256,
        });
        return jsonResponse({
          packageId,
          lookupStatus,
          message: buildLookupMessage(lookupStatus),
          candidateAssetCount: 0,
          decodedAssetCount: 0,
          results: [],
        });
      }

      const scoreResults = await runCouplingForensicsScore(extraction.assets, {
        baseUrl: config.couplingServiceBaseUrl,
        sharedSecret: config.couplingServiceSharedSecret,
      });

      const decodedResults = scoreResults.filter(
        (r) => r.preclassification === 'decoded' && r.tokenHex
      );

      if (decodedResults.length === 0) {
        const lookupStatus: ForensicsLookupStatus =
          scoreResults.length > 0 ? 'tampered_suspected' : 'no_candidate_assets';
        await convex.mutation(api.couplingForensics.recordLookupAudit, {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
          packageId,
          source: viewer.source,
          status: buildAuditStatus(lookupStatus),
          requestedTokenCount: 0,
          matchedTokenCount: 0,
          uploadSha256,
        });

        const results = scoreResults.map((scoreResult) => ({
          assetPath: scoreResult.assetPath,
          assetType: scoreResult.assetType,
          decoderKind: scoreResult.decoderKind,
          tokenLength: scoreResult.tokenLength,
          layerBClassification: classifyLayerB(scoreResult, new Set()) as LayerBClassification,
          matched: false,
          matches: [],
        }));

        return jsonResponse({
          packageId,
          lookupStatus,
          message: buildLookupMessage(lookupStatus),
          candidateAssetCount: extraction.assets.length,
          decodedAssetCount: 0,
          results,
          investigationReport: buildInvestigationReport(results, extraction.assets.length),
        });
      }

      const tokenHashes = decodedResults
        .filter((r) => r.tokenHex !== undefined)
        .map((r) => sha256HexFromBytes(new TextEncoder().encode(r.tokenHex as string)));

      const lookupResult = await convex.query(api.couplingForensics.lookupTraceMatchesForAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: viewer.authUserId,
        packageId,
        tokenHashes,
      });

      if (!lookupResult.capabilityEnabled) {
        await convex.mutation(api.couplingForensics.recordLookupAudit, {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
          packageId,
          source: viewer.source,
          status: 'denied',
          requestedTokenCount: tokenHashes.length,
          matchedTokenCount: 0,
          uploadSha256,
        });
        return jsonResponse(
          {
            error: 'Creator Studio+ is required for coupling traceability',
            code: 'coupling_traceability_required',
          },
          402
        );
      }

      if (!lookupResult.packageOwned) {
        await convex.mutation(api.couplingForensics.recordLookupAudit, {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
          packageId,
          source: viewer.source,
          status: 'denied',
          requestedTokenCount: tokenHashes.length,
          matchedTokenCount: 0,
          uploadSha256,
        });
        return jsonResponse({
          packageId,
          lookupStatus: 'hostile_unknown' satisfies ForensicsLookupStatus,
          message: buildLookupMessage('hostile_unknown'),
          candidateAssetCount: extraction.assets.length,
          decodedAssetCount: decodedResults.length,
          results: [],
          investigationReport: buildInvestigationReport([], extraction.assets.length),
        });
      }

      const matchesByTokenHash = new Map<string, typeof lookupResult.matches>();
      for (const match of lookupResult.matches) {
        const bucket = matchesByTokenHash.get(match.tokenHash) ?? [];
        bucket.push(match);
        matchesByTokenHash.set(match.tokenHash, bucket);
      }

      const matchedTokenHashSet = new Set<string>(
        lookupResult.matches.map((m: { tokenHash: string }) => m.tokenHash)
      );
      const enrichedMatches = await enrichTraceMatches(viewer, lookupResult.matches);
      const enrichedMatchesByTokenHash = new Map<string, typeof enrichedMatches>();
      for (const match of enrichedMatches) {
        const bucket = enrichedMatchesByTokenHash.get(match.tokenHash) ?? [];
        bucket.push(match);
        enrichedMatchesByTokenHash.set(match.tokenHash, bucket);
      }

      const results = scoreResults.map((scoreResult) => {
        const tokenHash = scoreResult.tokenHex
          ? sha256HexFromBytes(new TextEncoder().encode(scoreResult.tokenHex))
          : null;
        const matches = tokenHash ? (enrichedMatchesByTokenHash.get(tokenHash) ?? []) : [];
        const layerBClassification = classifyLayerB(scoreResult, matchedTokenHashSet);
        return {
          assetPath: scoreResult.assetPath,
          assetType: scoreResult.assetType,
          decoderKind: scoreResult.decoderKind,
          tokenLength: scoreResult.tokenLength,
          layerBClassification,
          matched: matches.length > 0,
          matches: matches.map((match: (typeof matches)[number]) => ({
            licenseSubject: match.licenseSubject,
            assetPath: match.assetPath,
            correlationId: match.correlationId,
            createdAt: match.createdAt,
            runtimeArtifactVersion: match.runtimeArtifactVersion,
            runtimePlaintextSha256: match.runtimePlaintextSha256,
            machineFingerprintHash: match.machineFingerprintHash,
            projectIdHash: match.projectIdHash,
            ...(match.grantId !== undefined ? { grantId: match.grantId } : {}),
            ...(match.packFamily !== undefined ? { packFamily: match.packFamily } : {}),
            ...(match.packVersion !== undefined ? { packVersion: match.packVersion } : {}),
            ...(match.provider !== undefined ? { provider: match.provider } : {}),
            ...(match.buyerProviderUserId !== undefined
              ? { buyerProviderUserId: match.buyerProviderUserId }
              : {}),
            ...(match.buyerProviderUsername !== undefined
              ? { buyerProviderUsername: match.buyerProviderUsername }
              : {}),
            ...(match.buyerSubjectDisplayName !== undefined
              ? { buyerSubjectDisplayName: match.buyerSubjectDisplayName }
              : {}),
            ...(match.buyerSubjectDiscordUserId !== undefined
              ? { buyerSubjectDiscordUserId: match.buyerSubjectDiscordUserId }
              : {}),
          })),
        };
      });

      const matchedTokenCount = results.filter((entry) => entry.matched).length;
      const lookupStatus: ForensicsLookupStatus =
        matchedTokenCount > 0 ? 'attributed' : 'hostile_unknown';
      await convex.mutation(api.couplingForensics.recordLookupAudit, {
        apiSecret: config.convexApiSecret,
        authUserId: viewer.authUserId,
        packageId,
        source: viewer.source,
        status: buildAuditStatus(lookupStatus),
        requestedTokenCount: tokenHashes.length,
        matchedTokenCount,
        uploadSha256,
      });

      return jsonResponse({
        packageId,
        lookupStatus,
        message: buildLookupMessage(lookupStatus),
        candidateAssetCount: extraction.assets.length,
        decodedAssetCount: decodedResults.length,
        results,
        investigationReport: buildInvestigationReport(results, extraction.assets.length),
      });
    } catch (error) {
      if (auditContext) {
        try {
          await convex.mutation(api.couplingForensics.recordLookupAudit, {
            apiSecret: config.convexApiSecret,
            authUserId: auditContext.authUserId,
            packageId: auditContext.packageId,
            source: auditContext.source,
            status: 'error',
            requestedTokenCount: 0,
            matchedTokenCount: 0,
            uploadSha256: auditContext.uploadSha256,
          });
        } catch (auditError) {
          logger.error('Failed to record coupling lookup error audit', {
            error: auditError instanceof Error ? auditError.message : String(auditError),
            packageId: auditContext.packageId,
          });
        }
      }

      if (error instanceof CouplingServiceConfigurationError) {
        logger.error('Coupling service is not configured for lookup requests', {
          error: error.message,
        });
        return jsonResponse({ error: 'Coupling forensics is not configured' }, 503);
      }

      if (error instanceof CouplingServiceRequestError) {
        logger.error('Coupling service scan failed', {
          error: error.message,
          status: error.status,
        });
        return jsonResponse({ error: 'Coupling forensics lookup failed' }, 502);
      }

      logger.error('Coupling forensics lookup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Coupling forensics lookup failed' }, 500);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }

  return {
    listPackages,
    lookup,
  };
}
