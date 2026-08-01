import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getInternalRpcSharedSecret, timingSafeStringEqual } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import type { Auth } from '../auth';
import { getClientAddress } from '../lib/clientAddress';
import { getConvexClientFromUrl } from '../lib/convex';
import { extractCouplingForensicsArchive } from '../lib/couplingForensicsArchives';
import {
  CouplingServiceConfigurationError,
  CouplingServiceRequestError,
  type ForensicsScoreResult,
  runCouplingAttribution,
} from '../lib/couplingForensicsService';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import type {
  MaterializationAttributionCandidate,
  MaterializationAttributionCandidatePage,
  MaterializationControlClient,
} from '../lib/materializationControlClient';
import {
  checkPublicApiRateLimit,
  getPublicApiRateLimitStore,
  type PublicApiRateLimitStore,
} from '../lib/publicApiRateLimit';
import { RequestBodyError, readRequestBytesWithLimit } from '../lib/requestBody';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_LOOKUP_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const MAX_UPLOAD_FILENAME_LENGTH = 128;
const FORENSICS_LOOKUP_RATE_LIMIT_MAX_REQUESTS = 30;
const FORENSICS_LOOKUP_RATE_LIMIT_WINDOW_MS = 60_000;
const FORENSICS_ATTRIBUTION_PAGE_SIZE = 256;
const FORENSICS_ATTRIBUTION_MAXIMUM_CANDIDATE_WORK = 4_096;
const FORENSICS_ATTRIBUTION_MAXIMUM_EVALUATION_WORK = 512 * 512;
/**
 * Wall-clock budget for the candidate scan.
 *
 * Without one the scan runs until an upstream proxy gives up, and every batch
 * of matching work already done is thrown away with it: a flat-colour upload
 * spent 141 s across twelve successful batches and returned a bare 504. The
 * scan now stops here and reports what it found, which is a real answer.
 */
const FORENSICS_ATTRIBUTION_SCAN_BUDGET_MS = 90_000;
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

export type ForensicsConfig = {
  apiBaseUrl: string;
  couplingServiceBaseUrl: string;
  couplingServiceSharedSecret: string;
  frontendBaseUrl: string;
  convexApiSecret: string;
  convexUrl: string;
  encryptionSecret: string;
  maxAttributionCandidateWork?: number;
  maxAttributionEvaluationWork?: number;
  maxLookupUploadBytes?: number;
  lookupRateLimitMaxRequests?: number;
  lookupRateLimitStore?: PublicApiRateLimitStore;
  lookupRateLimitWindowMs?: number;
  materializationControl?: Pick<MaterializationControlClient, 'listAttributionCandidates'>;
};

type ForensicsViewer = {
  authUserId: string;
  source: 'dashboard' | 'discord';
};

type ForensicsLookupStatus =
  | 'attributed'
  | 'tampered_suspected'
  | 'hostile_unknown'
  | 'no_signal_found'
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
    case 'no_signal_found':
      return 'No valid coupling signal was found';
    case 'no_candidate_assets':
      return 'No coupling candidate assets were found';
  }
}

function buildAuditStatus(
  status: ForensicsLookupStatus
):
  | 'matched'
  | 'attributed'
  | 'tampered_suspected'
  | 'hostile_unknown'
  | 'no_signal_found'
  | 'no_candidate_assets' {
  switch (status) {
    case 'attributed':
      return 'attributed';
    case 'tampered_suspected':
      return 'tampered_suspected';
    case 'hostile_unknown':
      return 'hostile_unknown';
    case 'no_signal_found':
      return 'no_signal_found';
    case 'no_candidate_assets':
      return 'no_candidate_assets';
  }
}

function jsonResponse(body: object, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
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

function sha256HexFromString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveLookupUploadLimit(config: ForensicsConfig): number {
  const configured = config.maxLookupUploadBytes;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return MAX_UPLOAD_SIZE_BYTES;
}

function resolveLookupRequestBodyLimit(maxLookupUploadBytes: number): number {
  return Math.min(
    maxLookupUploadBytes + MAX_LOOKUP_MULTIPART_OVERHEAD_BYTES,
    Number.MAX_SAFE_INTEGER
  );
}

function resolveLookupRateLimitMaxRequests(config: ForensicsConfig): number {
  const configured = config.lookupRateLimitMaxRequests;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return FORENSICS_LOOKUP_RATE_LIMIT_MAX_REQUESTS;
}

function resolveLookupRateLimitWindowMs(config: ForensicsConfig): number {
  const configured = config.lookupRateLimitWindowMs;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return FORENSICS_LOOKUP_RATE_LIMIT_WINDOW_MS;
}

function buildLookupRateLimitKey(viewer: ForensicsViewer, request: Request): string {
  const authUserHash = sha256HexFromString(viewer.authUserId);
  const clientAddressHash = sha256HexFromString(getClientAddress(request));
  return `forensics:lookup:user:${authUserHash}:ip:${clientAddressHash}`;
}

type MatchedAttributionCandidate = {
  assetPath: string;
  attributionId: string;
  buyerSubjectPseudonym: string;
  createdAt: number;
};

function resolveMaximumAttributionCandidateWork(config: ForensicsConfig): number {
  const maximum =
    config.maxAttributionCandidateWork ?? FORENSICS_ATTRIBUTION_MAXIMUM_CANDIDATE_WORK;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16_384) {
    throw new Error('Coupling attribution candidate work limit is invalid');
  }
  return maximum;
}

function resolveMaximumAttributionEvaluationWork(config: ForensicsConfig): number {
  const maximum =
    config.maxAttributionEvaluationWork ?? FORENSICS_ATTRIBUTION_MAXIMUM_EVALUATION_WORK;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4 * 1_024 * 1_024) {
    throw new Error('Coupling attribution evaluation work limit is invalid');
  }
  return maximum;
}

function mergeScoreResult(
  previous: ForensicsScoreResult | undefined,
  next: ForensicsScoreResult
): ForensicsScoreResult {
  if (!previous || next.preclassification === 'decoded') {
    return next;
  }
  if (previous.preclassification === 'no-signal' && next.preclassification === 'likely-stripped') {
    return next;
  }
  return previous;
}

function normalizeDeclaredPackageIds(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort(
    (left, right) => left.localeCompare(right)
  );
}

function buildMatchedAttributionCandidate(
  scoreResult: ForensicsScoreResult,
  candidatesById: ReadonlyMap<string, MatchedAttributionCandidate>
): MatchedAttributionCandidate | null {
  if (
    scoreResult.preclassification !== 'decoded' ||
    !scoreResult.matchedAttributionId ||
    !scoreResult.matchedBuyerSubjectPseudonym
  ) {
    return null;
  }
  const candidate = candidatesById.get(scoreResult.matchedAttributionId);
  if (!candidate || candidate.buyerSubjectPseudonym !== scoreResult.matchedBuyerSubjectPseudonym) {
    throw new CouplingServiceRequestError(
      'Coupling attribution returned a match outside the authorized candidate set',
      502
    );
  }
  return candidate;
}

function classifyLayerB(
  scoreResult: ForensicsScoreResult,
  matchedAttributionIds: ReadonlySet<string>
): LayerBClassification {
  if (scoreResult.preclassification === 'decoded') {
    if (!scoreResult.matchedAttributionId) {
      return 'no-signal-found';
    }
    return matchedAttributionIds.has(scoreResult.matchedAttributionId)
      ? 'trace-recovered'
      : 'tamper-suspected';
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
};

function buildInvestigationReport(
  results: Array<{
    layerBClassification: LayerBClassification;
  }>,
  totalAssets: number
): InvestigationReport {
  let decodedCount = 0;
  let attributedCount = 0;
  let unattributedCount = 0;
  let strippedCount = 0;
  let noSignalCount = 0;

  for (const result of results) {
    switch (result.layerBClassification) {
      case 'trace-recovered':
        decodedCount++;
        attributedCount++;
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

  return {
    totalAssets,
    decodedCount,
    attributedCount,
    unattributedCount,
    strippedCount,
    noSignalCount,
  };
}

function buildLookupMatchId(
  config: ForensicsConfig,
  packageId: string,
  match: {
    attributionId: string;
    buyerSubjectPseudonym: string;
    assetPath: string;
  }
): string {
  return createHmac('sha256', config.encryptionSecret)
    .update('forensics-lookup-match-v2')
    .update('\0')
    .update(packageId)
    .update('\0')
    .update(match.attributionId)
    .update('\0')
    .update(match.buyerSubjectPseudonym)
    .update('\0')
    .update(match.assetPath)
    .digest('hex');
}

function buildLookupBuyerMatchId(
  config: ForensicsConfig,
  packageId: string,
  match: {
    buyerSubjectPseudonym: string;
  }
): string {
  return createHmac('sha256', config.encryptionSecret)
    .update('forensics-lookup-buyer-match-v2')
    .update('\0')
    .update(packageId)
    .update('\0')
    .update(match.buyerSubjectPseudonym)
    .digest('hex');
}

export function createForensicsRoutes(auth: Auth, config: ForensicsConfig) {
  const convex = getConvexClientFromUrl(config.convexUrl);
  const maximumAttributionCandidateWork = resolveMaximumAttributionCandidateWork(config);
  const maximumAttributionEvaluationWork = resolveMaximumAttributionEvaluationWork(config);

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

    const rateLimit = await checkPublicApiRateLimit({
      store: config.lookupRateLimitStore ?? getPublicApiRateLimitStore(),
      key: buildLookupRateLimitKey(viewer, request),
      limit: resolveLookupRateLimitMaxRequests(config),
      windowMs: resolveLookupRateLimitWindowMs(config),
    });
    if (!rateLimit.allowed) {
      return jsonResponse({ error: 'Too many requests' }, 429, rateLimit.headers);
    }

    const maxLookupUploadBytes = resolveLookupUploadLimit(config);
    const maxLookupRequestBodyBytes = resolveLookupRequestBodyLimit(maxLookupUploadBytes);
    let boundedRequestBody: Uint8Array;
    try {
      boundedRequestBody = await readRequestBytesWithLimit(request, maxLookupRequestBodyBytes);
    } catch (error) {
      if (error instanceof RequestBodyError && error.status === 413) {
        return jsonResponse({ error: 'Upload exceeds the size limit' }, 413);
      }
      throw error;
    }
    const formDataHeaders = new Headers(request.headers);
    formDataHeaders.delete('content-length');

    const workspaceDir = await mkdtemp(path.join(tmpdir(), 'yucp-forensics-'));
    let auditContext: {
      authUserId: string;
      packageId: string;
      source: ForensicsViewer['source'];
      uploadSha256?: string;
    } | null = null;
    try {
      let formData: FormData;
      try {
        formData = await new Request(request.url, {
          method: request.method,
          headers: formDataHeaders,
          body: boundedRequestBody.buffer as ArrayBuffer,
        }).formData();
      } catch {
        return jsonResponse({ error: 'Invalid multipart form data' }, 400);
      }
      let packageId: string;
      try {
        packageId = assertPackageId(String(formData.get('packageId') ?? ''));
      } catch {
        return jsonResponse({ error: 'Invalid packageId format' }, 400);
      }
      const upload = formData.get('file');
      if (!(upload instanceof File)) {
        return jsonResponse({ error: 'Missing upload file' }, 400);
      }
      if (upload.size <= 0) {
        return jsonResponse({ error: 'Upload is empty' }, 400);
      }
      if (upload.size > maxLookupUploadBytes) {
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
          requestedCandidateCount: 0,
          matchedAttributionCount: 0,
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
          requestedCandidateCount: 0,
          matchedAttributionCount: 0,
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

      const authorization = await convex.query(
        api.couplingForensics.authorizeCouplingForensicsLookupForAuthUser,
        {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
          packageId,
        }
      );

      if (!authorization.capabilityEnabled) {
        await convex.mutation(api.couplingForensics.recordLookupAudit, {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
          packageId,
          source: viewer.source,
          status: 'denied',
          requestedCandidateCount: 0,
          matchedAttributionCount: 0,
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

      if (!authorization.packageOwned) {
        await convex.mutation(api.couplingForensics.recordLookupAudit, {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
          packageId,
          source: viewer.source,
          status: 'denied',
          requestedCandidateCount: 0,
          matchedAttributionCount: 0,
          uploadSha256,
        });
        return jsonResponse({
          packageId,
          lookupStatus: 'hostile_unknown' satisfies ForensicsLookupStatus,
          message: buildLookupMessage('hostile_unknown'),
          candidateAssetCount: extraction.assets.length,
          decodedAssetCount: 0,
          results: [],
          investigationReport: buildInvestigationReport([], extraction.assets.length),
        });
      }

      if (!config.materializationControl) {
        throw new CouplingServiceConfigurationError(
          'Materialization attribution control is not configured'
        );
      }
      const candidatesById = new Map<string, MatchedAttributionCandidate>();
      const durableCandidatesById = new Map<string, MaterializationAttributionCandidate>();
      const scoreResultsByPath = new Map<string, ForensicsScoreResult>();
      let unresolvedAssets = [...extraction.assets];
      let requestedCandidateCount = 0;
      let candidateEvaluationCount = 0;
      let cursor: string | undefined;
      const candidateTraceparent = request.headers.get('traceparent');
      const traceparent =
        candidateTraceparent && TRACEPARENT_PATTERN.test(candidateTraceparent)
          ? candidateTraceparent
          : undefined;
      const buildCandidateWorkLimitResponse = async (): Promise<Response> => {
        logger.warn('Coupling attribution work limit reached', {
          candidateEvaluationCount,
          packageId,
          requestedCandidateCount,
        });
        await convex.mutation(api.couplingForensics.recordLookupAudit, {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
          packageId,
          source: viewer.source,
          status: 'error',
          requestedCandidateCount,
          matchedAttributionCount: 0,
          uploadSha256,
        });
        return jsonResponse(
          {
            error: 'Attribution candidate work limit reached before the scan was complete.',
            code: 'coupling_trace_candidate_limit_exceeded',
            candidateLimit: maximumAttributionCandidateWork,
            candidateEvaluationCount,
            candidateEvaluationLimit: maximumAttributionEvaluationWork,
            requestedCandidateCount,
          },
          409
        );
      };

      const scanStartedAt = Date.now();
      let scanPageIndex = 0;
      let scanDeadlineReached = false;
      let evaluationsPerformed = 0;
      // A record of what each page actually did, so the dashboard can show the
      // scan as it happened rather than a spinner followed by a verdict.
      const scanPages: Array<{
        buyersCompared: number;
        elapsedMs: number;
        page: number;
        resolved: number;
        unresolvedAfter: number;
      }> = [];
      logger.info('Coupling attribution scan started', {
        assetCount: extraction.assets.length,
        packageId,
        uploadSha256,
      });
      for (;;) {
        if (Date.now() - scanStartedAt >= FORENSICS_ATTRIBUTION_SCAN_BUDGET_MS) {
          // Every batch already scored is kept: the caller gets the matches
          // found so far plus an explicit incomplete flag, rather than a 504
          // that discards minutes of successful work.
          scanDeadlineReached = true;
          logger.warn('Coupling attribution scan budget reached', {
            candidateEvaluationCount,
            elapsedMs: Date.now() - scanStartedAt,
            packageId,
            pagesScanned: scanPageIndex,
            requestedCandidateCount,
            unresolvedAssetCount: unresolvedAssets.length,
          });
          break;
        }
        const remainingCandidateWork = maximumAttributionCandidateWork - requestedCandidateCount;
        const remainingEvaluationWork = maximumAttributionEvaluationWork - candidateEvaluationCount;
        const requestedPageLimit = Math.min(
          FORENSICS_ATTRIBUTION_PAGE_SIZE,
          remainingCandidateWork,
          Math.floor(remainingEvaluationWork / Math.max(1, unresolvedAssets.length))
        );
        if (requestedPageLimit < 1) {
          return await buildCandidateWorkLimitResponse();
        }
        const candidateResult: MaterializationAttributionCandidatePage =
          await config.materializationControl.listAttributionCandidates({
            candidateLimit: requestedPageLimit,
            creatorId: viewer.authUserId,
            ...(cursor ? { cursor } : {}),
            productId: packageId,
            ...(traceparent ? { traceparent } : {}),
          });
        if (
          candidateResult.candidateLimit !== requestedPageLimit ||
          candidateResult.candidates.length > requestedPageLimit ||
          (candidateResult.truncated &&
            (candidateResult.candidates.length !== requestedPageLimit ||
              !candidateResult.nextCursor))
        ) {
          throw new CouplingServiceRequestError(
            'Materialization control returned an invalid attribution page',
            502
          );
        }

        requestedCandidateCount += candidateResult.candidates.length;
        candidateEvaluationCount += candidateResult.candidates.length * unresolvedAssets.length;
        for (const candidate of candidateResult.candidates) {
          if (durableCandidatesById.has(candidate.attributionId)) {
            throw new CouplingServiceRequestError(
              'Materialization control returned duplicate attribution candidates',
              502
            );
          }
          durableCandidatesById.set(candidate.attributionId, candidate);
          candidatesById.set(candidate.attributionId, {
            assetPath: candidate.normalizedPath,
            attributionId: candidate.attributionId,
            buyerSubjectPseudonym: candidate.buyerSubjectPseudonym,
            createdAt: candidate.createdAt,
          });
        }

        if (candidateResult.candidates.length > 0 && unresolvedAssets.length > 0) {
          const pageOutcome = await runCouplingAttribution(
            unresolvedAssets,
            candidateResult.candidates.map(({ createdAt: _createdAt, ...candidate }) => candidate),
            {
              baseUrl: config.couplingServiceBaseUrl,
              deadlineAtMs: scanStartedAt + FORENSICS_ATTRIBUTION_SCAN_BUDGET_MS,
              sharedSecret: config.couplingServiceSharedSecret,
            }
          );
          // The service stops starting batches once the deadline is close, so
          // an incomplete page means the scan as a whole is incomplete.
          if (!pageOutcome.complete) {
            scanDeadlineReached = true;
          }
          evaluationsPerformed += pageOutcome.evaluationsPerformed;
          for (const scoreResult of pageOutcome.results) {
            scoreResultsByPath.set(
              scoreResult.assetPath,
              mergeScoreResult(scoreResultsByPath.get(scoreResult.assetPath), scoreResult)
            );
          }
          const beforeUnresolved = unresolvedAssets.length;
          // Only a decoded asset leaves the work set. 'no-signal' means this
          // page's candidates did not match, not that the asset carries no
          // mark, so dropping it here would stop the scan before a buyer on a
          // later page could ever be found.
          unresolvedAssets = unresolvedAssets.filter(
            (asset) => scoreResultsByPath.get(asset.assetPath)?.preclassification !== 'decoded'
          );
          scanPageIndex += 1;
          const pageElapsedMs = Date.now() - scanStartedAt;
          const resolvedInPage = beforeUnresolved - unresolvedAssets.length;
          scanPages.push({
            buyersCompared: candidateResult.candidates.length,
            elapsedMs: pageElapsedMs,
            page: scanPageIndex,
            resolved: resolvedInPage,
            unresolvedAfter: unresolvedAssets.length,
          });
          logger.info('Coupling attribution page scored', {
            candidatesInPage: candidateResult.candidates.length,
            elapsedMs: pageElapsedMs,
            packageId,
            pageIndex: scanPageIndex,
            resolvedInPage,
            unresolvedAssetCount: unresolvedAssets.length,
          });
        }

        if (scanDeadlineReached) {
          // Without this break the loop keeps paging candidates the service
          // will refuse, and can spuriously trip the 409 work limit instead of
          // returning the partial verdict.
          break;
        }
        if (unresolvedAssets.length === 0 || !candidateResult.truncated) {
          break;
        }
        const canEvaluateAnotherCandidate =
          maximumAttributionEvaluationWork - candidateEvaluationCount >= unresolvedAssets.length;
        if (
          requestedCandidateCount >= maximumAttributionCandidateWork ||
          !canEvaluateAnotherCandidate
        ) {
          return await buildCandidateWorkLimitResponse();
        }
        cursor = candidateResult.nextCursor;
      }
      const scanDurationMs = Date.now() - scanStartedAt;
      const scanSummary = {
        // The evaluations the service actually performed, not the charged
        // estimate: deadline stops and early decode both leave the estimate
        // higher than the work done.
        candidateEvaluationCount: evaluationsPerformed,
        complete: !scanDeadlineReached,
        durationMs: scanDurationMs,
        pages: scanPages,
        pagesScanned: scanPageIndex,
        requestedCandidateCount,
      };
      logger.info('Coupling attribution scan finished', {
        ...scanSummary,
        assetCount: extraction.assets.length,
        packageId,
        uploadSha256,
      });

      if (durableCandidatesById.size === 0) {
        const lookupStatus: ForensicsLookupStatus = 'no_signal_found';
        await convex.mutation(api.couplingForensics.recordLookupAudit, {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
          packageId,
          source: viewer.source,
          status: buildAuditStatus(lookupStatus),
          requestedCandidateCount: 0,
          matchedAttributionCount: 0,
          uploadSha256,
        });
        return jsonResponse({
          packageId,
          lookupStatus,
          message: buildLookupMessage(lookupStatus),
          candidateAssetCount: extraction.assets.length,
          decodedAssetCount: 0,
          results: [],
          investigationReport: buildInvestigationReport([], extraction.assets.length),
          scan: scanSummary,
        });
      }

      const scoreResults: ForensicsScoreResult[] = extraction.assets.map(
        (asset) =>
          scoreResultsByPath.get(asset.assetPath) ?? {
            assetPath: asset.assetPath,
            assetType: asset.assetType,
            decoderKind: asset.assetType,
            preclassification: 'no-signal',
          }
      );

      const decodedResults = scoreResults.filter(
        (result) =>
          result.preclassification === 'decoded' &&
          Boolean(result.matchedAttributionId) &&
          Boolean(result.matchedBuyerSubjectPseudonym)
      );

      if (decodedResults.length === 0) {
        const results = scoreResults.map((scoreResult) => ({
          assetPath: scoreResult.assetPath,
          assetType: scoreResult.assetType,
          decoderKind: scoreResult.decoderKind,
          layerBClassification: classifyLayerB(scoreResult, new Set()) as LayerBClassification,
          matched: false,
          matches: [],
        }));
        const hasPositiveTamperEvidence = results.some(
          (result) =>
            result.layerBClassification === 'tamper-suspected' ||
            result.layerBClassification === 'trace-likely-stripped'
        );
        const lookupStatus: ForensicsLookupStatus =
          scoreResults.length === 0
            ? 'no_candidate_assets'
            : hasPositiveTamperEvidence
              ? 'tampered_suspected'
              : 'no_signal_found';
        await convex.mutation(api.couplingForensics.recordLookupAudit, {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
          packageId,
          source: viewer.source,
          status: buildAuditStatus(lookupStatus),
          requestedCandidateCount,
          matchedAttributionCount: 0,
          uploadSha256,
        });

        return jsonResponse({
          packageId,
          lookupStatus,
          message: buildLookupMessage(lookupStatus),
          candidateAssetCount: extraction.assets.length,
          decodedAssetCount: 0,
          results,
          investigationReport: buildInvestigationReport(results, extraction.assets.length),
          scan: scanSummary,
        });
      }

      const matchedAttributionIds = new Set(
        decodedResults.flatMap((result) =>
          result.matchedAttributionId ? [result.matchedAttributionId] : []
        )
      );

      const results = scoreResults.map((scoreResult) => {
        const candidate = buildMatchedAttributionCandidate(scoreResult, candidatesById);
        const layerBClassification = classifyLayerB(scoreResult, matchedAttributionIds);
        return {
          assetPath: scoreResult.assetPath,
          assetType: scoreResult.assetType,
          decoderKind: scoreResult.decoderKind,
          layerBClassification,
          matched: Boolean(candidate),
          matches: candidate
            ? [
                {
                  matchId: buildLookupMatchId(config, packageId, candidate),
                  buyerMatchId: buildLookupBuyerMatchId(config, packageId, candidate),
                  assetPath: candidate.assetPath,
                  attributionId: candidate.attributionId,
                  buyerSubjectPseudonym: candidate.buyerSubjectPseudonym,
                  createdAt: candidate.createdAt,
                  runtimeArtifactVersion: durableCandidatesById.get(candidate.attributionId)
                    ?.pluginVersion,
                },
              ]
            : [],
        };
      });

      const matchedAttributionCount = results.filter((entry) => entry.matched).length;
      const lookupStatus: ForensicsLookupStatus =
        matchedAttributionCount > 0 ? 'attributed' : 'hostile_unknown';
      await convex.mutation(api.couplingForensics.recordLookupAudit, {
        apiSecret: config.convexApiSecret,
        authUserId: viewer.authUserId,
        packageId,
        source: viewer.source,
        status: buildAuditStatus(lookupStatus),
        requestedCandidateCount,
        matchedAttributionCount,
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
        scan: scanSummary,
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
            requestedCandidateCount: 0,
            matchedAttributionCount: 0,
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
