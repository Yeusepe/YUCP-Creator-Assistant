import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger, getInternalRpcSharedSecret, timingSafeStringEqual } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import type { Auth } from '../auth';
import { getConvexClientFromUrl } from '../lib/convex';
import { extractCouplingForensicsArchive } from '../lib/couplingForensicsArchives';
import {
  CouplingServiceConfigurationError,
  CouplingServiceRequestError,
  runCouplingForensicsScan,
} from '../lib/couplingForensicsService';
import { rejectCrossSiteRequest } from '../lib/csrf';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;

export type ForensicsConfig = {
  apiBaseUrl: string;
  couplingServiceBaseUrl: string;
  couplingServiceSharedSecret: string;
  frontendBaseUrl: string;
  convexApiSecret: string;
  convexUrl: string;
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

function buildLookupMessage(status: ForensicsLookupStatus): string {
  switch (status) {
    case 'attributed':
      return 'Authorized matches found';
    case 'tampered_suspected':
      return 'Candidate assets were found, but no valid coupling signals could be decoded';
    case 'hostile_unknown':
      return 'Coupling signals were decoded, but none matched an authorized trace record';
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

export function createForensicsRoutes(auth: Auth, config: ForensicsConfig) {
  const convex = getConvexClientFromUrl(config.convexUrl);

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
      const uploadPath = path.join(workspaceDir, upload.name || 'upload.bin');
      await Bun.write(uploadPath, uploadBytes);

      const extraction = await extractCouplingForensicsArchive(
        uploadPath,
        upload.name || 'upload.bin',
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
          message: 'No authorized match found',
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

      const findings = await runCouplingForensicsScan(extraction.assets, {
        baseUrl: config.couplingServiceBaseUrl,
        sharedSecret: config.couplingServiceSharedSecret,
      });
      if (findings.length === 0) {
        const lookupStatus: ForensicsLookupStatus = 'tampered_suspected';
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
          candidateAssetCount: extraction.assets.length,
          decodedAssetCount: 0,
          results: [],
        });
      }
      const tokenHashes = findings.map((finding) =>
        sha256HexFromBytes(new TextEncoder().encode(finding.tokenHex))
      );
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
          message: 'No authorized match found',
          candidateAssetCount: extraction.assets.length,
          decodedAssetCount: findings.length,
          results: [],
        });
      }

      const matchesByTokenHash = new Map<string, typeof lookupResult.matches>();
      for (const match of lookupResult.matches) {
        const bucket = matchesByTokenHash.get(match.tokenHash) ?? [];
        bucket.push(match);
        matchesByTokenHash.set(match.tokenHash, bucket);
      }

      const results = findings.map((finding) => {
        const tokenHash = sha256HexFromBytes(new TextEncoder().encode(finding.tokenHex));
        const matches = matchesByTokenHash.get(tokenHash) ?? [];
        return {
          assetPath: finding.assetPath,
          assetType: finding.assetType,
          decoderKind: finding.decoderKind,
          tokenLength: finding.tokenLength,
          matched: matches.length > 0,
          classification: matches.length > 0 ? 'attributed' : 'hostile_unknown',
          matches: matches.map((match: (typeof matches)[number]) => ({
            licenseSubject: match.licenseSubject,
            assetPath: match.assetPath,
            correlationId: match.correlationId,
            createdAt: match.createdAt,
            runtimeArtifactVersion: match.runtimeArtifactVersion,
            runtimePlaintextSha256: match.runtimePlaintextSha256,
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
        decodedAssetCount: findings.length,
        results,
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
