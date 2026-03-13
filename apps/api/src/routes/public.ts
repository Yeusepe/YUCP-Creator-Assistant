import { createLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { getConvexClientFromUrl } from '../lib/convex';
import { verifyBetterAuthAccessToken } from '../lib/oauthAccessToken';
import { PUBLIC_API_KEY_PREFIX } from '../lib/publicApiKeys';
import { createPublicApiSupportError } from '../lib/verificationSupport';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
const VERIFICATION_SCOPE = 'verification:read';
const SUBJECTS_SCOPE = 'subjects:read';
const MAX_PRODUCT_IDS_PER_CHECK = 50;
const PUBLIC_API_KEY_PERMISSION_NAMESPACE = 'publicApi';

export interface PublicRouteConfig {
  convexUrl: string;
  convexApiSecret: string;
  convexSiteUrl: string;
  oauthAudience?: string;
}

export interface SubjectSelectorById {
  subjectId: string;
}

export interface SubjectSelectorByAuthUserId {
  authUserId: string;
}

export interface SubjectSelectorByDiscordUserId {
  discordUserId: string;
}

export interface SubjectSelectorByExternalAccount {
  externalAccount: {
    provider: string;
    providerUserId: string;
  };
}

export type SubjectSelector =
  | SubjectSelectorById
  | SubjectSelectorByAuthUserId
  | SubjectSelectorByDiscordUserId
  | SubjectSelectorByExternalAccount;

interface PublicRouteDependencies {
  createConvexClient?: typeof getConvexClientFromUrl;
  verifyAccessToken?: (
    token: string,
    config: PublicRouteConfig,
    scopes: string[]
  ) => Promise<{ sub: string } | null>;
  verifyApiKey?: (
    apiKey: string,
    config: PublicRouteConfig
  ) => Promise<BetterAuthVerifiedApiKey | null>;
}

interface PublicEntitlement {
  grantedAt: number;
  productId: string;
  sourceProvider: string;
  status: string;
}

interface PublicSubject {
  _id: Id<'subjects'>;
  authUserId?: string;
  primaryDiscordUserId: string;
  status: 'active' | 'suspended' | 'quarantined' | 'deleted';
}

interface BetterAuthPermissionStatements {
  [key: string]: string[];
}

interface BetterAuthVerifiedApiKey {
  id: string;
  name?: string | null;
  prefix?: string | null;
  start?: string | null;
  enabled?: boolean;
  createdAt?: unknown;
  expiresAt?: unknown;
  lastRequest?: unknown;
  metadata?: unknown;
  permissions?: BetterAuthPermissionStatements | null;
}

interface VerifiedPublicApiKey {
  expiresAt?: number;
  id: string;
  lastUsedAt?: number;
  scopes: string[];
  authUserId: string;
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Returns error response with encrypted supportCode (same format as verify flow) for debugging. */
async function errorResponseWithSupportCode(
  realError: string | Error,
  genericMessage: string,
  status: number,
  options: { stage: string; authUserId?: string }
): Promise<Response> {
  const support = await createPublicApiSupportError(logger, {
    error: typeof realError === 'string' ? new Error(realError) : realError,
    stage: options.stage,
    authUserId: options.authUserId,
  });
  const errorCode =
    status === 401
      ? 'unauthorized'
      : status === 403
        ? 'forbidden'
        : status === 404 || status === 200
          ? 'not_found'
          : 'bad_request';
  return jsonResponse(
    { error: errorCode, message: genericMessage, supportCode: support.supportCode },
    status
  );
}

function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7).trim() || null;
}

/** Extracts API key from x-api-key header or Authorization: Bearer (when token looks like ypsk_*). */
function extractApiKey(request: Request): string | null {
  const fromHeader = request.headers.get('x-api-key')?.trim();
  if (fromHeader) return fromHeader;
  const bearer = extractBearerToken(request);
  if (bearer?.startsWith(PUBLIC_API_KEY_PREFIX)) return bearer;
  return null;
}

export function parseSubjectSelector(value: unknown): SubjectSelector | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const keys = ['subjectId', 'authUserId', 'discordUserId', 'externalAccount'].filter(
    (key) => raw[key] !== undefined
  );
  if (keys.length !== 1) {
    return null;
  }

  if (typeof raw.subjectId === 'string' && raw.subjectId.trim()) {
    return { subjectId: raw.subjectId.trim() };
  }
  if (typeof raw.authUserId === 'string' && raw.authUserId.trim()) {
    return { authUserId: raw.authUserId.trim() };
  }
  if (typeof raw.discordUserId === 'string' && raw.discordUserId.trim()) {
    return { discordUserId: raw.discordUserId.trim() };
  }
  if (raw.externalAccount && typeof raw.externalAccount === 'object') {
    const externalAccount = raw.externalAccount as Record<string, unknown>;
    if (
      typeof externalAccount.provider === 'string' &&
      externalAccount.provider.trim() &&
      typeof externalAccount.providerUserId === 'string' &&
      externalAccount.providerUserId.trim()
    ) {
      return {
        externalAccount: {
          provider: externalAccount.provider.trim(),
          providerUserId: externalAccount.providerUserId.trim(),
        },
      };
    }
  }

  return null;
}

/** Parse flat identity fields from verify request (oneOf: exactly one required). */
function parseVerifyRequestSelector(body: Record<string, unknown>): SubjectSelector | null {
  const identityKeys = [
    'subjectId',
    'authUserId',
    'discordUserId',
    'vrchatUserId',
    'gumroadUserId',
    'jinxxyEmail',
    'jinxxyUserId',
  ] as const;
  const present = identityKeys.filter((k) => {
    const v = body[k];
    return typeof v === 'string' && v.trim().length > 0;
  });
  if (present.length !== 1) {
    return null;
  }

  const key = present[0];
  const value = (body[key] as string).trim();

  if (key === 'subjectId') return { subjectId: value };
  if (key === 'authUserId') return { authUserId: value };
  if (key === 'discordUserId') return { discordUserId: value };
  if (key === 'vrchatUserId')
    return { externalAccount: { provider: 'vrchat', providerUserId: value } };
  if (key === 'gumroadUserId')
    return { externalAccount: { provider: 'gumroad', providerUserId: value } };
  if (key === 'jinxxyUserId')
    return { externalAccount: { provider: 'jinxxy', providerUserId: value } };
  if (key === 'jinxxyEmail')
    return { externalAccount: { provider: 'jinxxy', providerUserId: value } };

  return null;
}

function hasScopes(grantedScopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.every((scope) => grantedScopes.includes(scope));
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  return undefined;
}

function parseApiKeyMetadata(metadata: unknown): { kind?: string; authUserId?: string } | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  return {
    kind: typeof record.kind === 'string' ? record.kind : undefined,
    authUserId: typeof record.authUserId === 'string' ? record.authUserId : undefined,
  };
}

function getPublicApiKeyScopes(
  permissions: BetterAuthPermissionStatements | null | undefined
): string[] {
  if (!permissions || typeof permissions !== 'object') {
    return [];
  }

  const scopes = permissions[PUBLIC_API_KEY_PERMISSION_NAMESPACE];
  return Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
}

async function defaultVerifyAccessToken(
  token: string,
  config: PublicRouteConfig,
  scopes: string[]
): Promise<{ sub: string } | null> {
  const result = await verifyBetterAuthAccessToken(token, {
    convexSiteUrl: config.convexSiteUrl,
    audience: config.oauthAudience ?? 'yucp-public-api',
    requiredScopes: scopes,
    logger,
    logContext: 'Public API OAuth token verification failed',
  });
  return result.ok ? { sub: result.token.sub } : null;
}

async function defaultVerifyApiKey(
  apiKey: string,
  config: PublicRouteConfig
): Promise<BetterAuthVerifiedApiKey | null> {
  const convex = getConvexClientFromUrl(config.convexUrl);

  try {
    const result = (await convex.mutation(api.betterAuthApiKeys.verifyApiKey, {
      apiSecret: config.convexApiSecret,
      key: apiKey,
    })) as {
      valid: boolean;
      error: { code: string; message: string | null } | null;
      key: {
        id: string;
        userId: string;
        name: string | null;
        start: string | null;
        prefix: string | null;
        enabled: boolean;
        permissions: BetterAuthPermissionStatements | null;
        metadata: { kind: string; authUserId: string } | null;
        lastRequestAt: number | null;
        expiresAt: number | null;
        createdAt: number | null;
      } | null;
    };

    if (!result.valid || !result.key) {
      return null;
    }

    return {
      id: result.key.id,
      name: result.key.name,
      start: result.key.start,
      prefix: result.key.prefix,
      enabled: result.key.enabled,
      permissions: result.key.permissions,
      metadata: result.key.metadata,
      lastRequest: result.key.lastRequestAt ?? undefined,
      expiresAt: result.key.expiresAt ?? undefined,
      createdAt: result.key.createdAt ?? undefined,
    };
  } catch (error) {
    logger.warn('Public API key verification failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function getVerificationStatusResponse(
  convex: ReturnType<typeof getConvexClientFromUrl>,
  config: PublicRouteConfig,
  authUserId: string,
  subjectId: string
): Promise<Response> {
  const entitlements = (await convex.query(api.entitlements.getEntitlementsBySubject, {
    apiSecret: config.convexApiSecret,
    authUserId,
    subjectId,
    includeInactive: false,
  })) as PublicEntitlement[];

  const products = (entitlements ?? []).map((entitlement) => ({
    productId: entitlement.productId,
    status: entitlement.status,
    grantedAt: entitlement.grantedAt,
    sourceProvider: entitlement.sourceProvider,
  }));

  return jsonResponse({
    verified: products.length > 0,
    subjectId,
    products,
  });
}

async function resolveSubjectOrResponse(
  convex: ReturnType<typeof getConvexClientFromUrl>,
  config: PublicRouteConfig,
  authUserId: string,
  selector: SubjectSelector,
  notFoundStatus = 404
): Promise<{ subject: PublicSubject } | { response: Response }> {
  const resolved = (await convex.query(api.subjects.resolveSubjectForPublicApi, {
    apiSecret: config.convexApiSecret,
    authUserId,
    selector,
  })) as { found?: boolean; subject?: PublicSubject | null } | null;

  if (!resolved?.found || !resolved.subject) {
    return {
      response: await errorResponseWithSupportCode(
        'Subject not found',
        'Resource not found',
        notFoundStatus,
        { stage: 'resolve_subject', authUserId }
      ),
    };
  }

  if (resolved.subject.status !== 'active') {
    return {
      response: await errorResponseWithSupportCode('Subject is not active', 'Access denied', 403, {
        stage: 'resolve_subject',
        authUserId,
      }),
    };
  }

  return { subject: resolved.subject };
}

async function authenticateServiceKey(
  request: Request,
  config: PublicRouteConfig,
  authUserId: string,
  requiredScopes: string[],
  verifyApiKey: (apiKey: string, cfg: PublicRouteConfig) => Promise<BetterAuthVerifiedApiKey | null>
): Promise<{ key: VerifiedPublicApiKey } | { response: Response }> {
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return {
      response: await errorResponseWithSupportCode(
        'Missing API key (x-api-key header or Authorization: Bearer)',
        'Authentication failed',
        401,
        { stage: 'auth', authUserId }
      ),
    };
  }

  const verified = await verifyApiKey(apiKey, config);
  if (!verified || verified.enabled === false) {
    return {
      response: await errorResponseWithSupportCode(
        'Invalid API key',
        'Authentication failed',
        401,
        { stage: 'auth', authUserId }
      ),
    };
  }

  const metadata = parseApiKeyMetadata(verified.metadata);
  if (metadata?.kind !== 'public-api' || metadata.authUserId !== authUserId) {
    return {
      response: await errorResponseWithSupportCode(
        'API key is not valid for this tenant',
        'Access denied',
        403,
        { stage: 'auth', authUserId }
      ),
    };
  }

  const scopes = getPublicApiKeyScopes(verified.permissions);
  if (!hasScopes(scopes, requiredScopes)) {
    return {
      response: await errorResponseWithSupportCode(
        'Insufficient API key scope',
        'Access denied',
        403,
        { stage: 'auth', authUserId }
      ),
    };
  }

  const expiresAt = toTimestamp(verified.expiresAt);
  if (expiresAt && expiresAt <= Date.now()) {
    return {
      response: await errorResponseWithSupportCode(
        'API key expired',
        'Authentication failed',
        401,
        { stage: 'auth', authUserId }
      ),
    };
  }

  return {
    key: {
      id: verified.id,
      authUserId,
      scopes,
      expiresAt,
      lastUsedAt: toTimestamp(verified.lastRequest),
    },
  };
}

async function authenticateVerifyRequest(
  request: Request,
  config: PublicRouteConfig,
  convex: ReturnType<typeof getConvexClientFromUrl>,
  authUserId: string,
  verifyAccessToken: (
    token: string,
    cfg: PublicRouteConfig,
    scopes: string[]
  ) => Promise<{ sub: string } | null>,
  verifyApiKey: (apiKey: string, cfg: PublicRouteConfig) => Promise<BetterAuthVerifiedApiKey | null>
): Promise<{ authUserId: string } | { response: Response }> {
  const apiKey = extractApiKey(request);
  const bearerToken = extractBearerToken(request);

  if (apiKey) {
    const auth = await authenticateServiceKey(
      request,
      config,
      authUserId,
      [VERIFICATION_SCOPE],
      verifyApiKey
    );
    if ('response' in auth) return auth;
    return { authUserId };
  }

  if (bearerToken) {
    const verified = await verifyAccessToken(bearerToken, config, [VERIFICATION_SCOPE]);
    if (!verified) {
      return {
        response: await errorResponseWithSupportCode(
          'Invalid or expired access token',
          'Authentication failed',
          401,
          { stage: 'verify_auth' }
        ),
      };
    }
    return { authUserId };
  }

  return {
    response: await errorResponseWithSupportCode(
      'Missing API key (x-api-key or Authorization: Bearer) or OAuth access token',
      'Authentication failed',
      401,
      { stage: 'verify_auth' }
    ),
  };
}

export function createPublicRoutes(config: PublicRouteConfig, deps: PublicRouteDependencies = {}) {
  const createConvexClient = deps.createConvexClient ?? getConvexClientFromUrl;
  const verifyAccessToken = deps.verifyAccessToken ?? defaultVerifyAccessToken;
  const verifyApiKey = deps.verifyApiKey ?? defaultVerifyApiKey;

  async function getTenantBySlug(_request: Request, slug: string): Promise<Response> {
    const convex = createConvexClient(config.convexUrl);
    const tenant = (await convex.query(api.tenants.getTenantBySlug, {
      apiSecret: config.convexApiSecret,
      slug,
    })) as { _id: string; name: string; slug: string } | null;

    if (!tenant) {
      return await errorResponseWithSupportCode('Tenant not found', 'Resource not found', 404, {
        stage: 'tenants',
      });
    }

    return jsonResponse({
      authUserId: tenant._id,
      name: tenant.name,
      slug: tenant.slug,
    });
  }

  async function getMeVerificationStatus(request: Request): Promise<Response> {
    const token = extractBearerToken(request);
    if (!token) {
      return await errorResponseWithSupportCode(
        'Missing or invalid Authorization header',
        'Authentication failed',
        401,
        { stage: 'me_verification_status' }
      );
    }

    const verified = await verifyAccessToken(token, config, [VERIFICATION_SCOPE]);
    if (!verified) {
      return await errorResponseWithSupportCode(
        'Invalid or expired access token',
        'Authentication failed',
        401,
        { stage: 'me_verification_status' }
      );
    }

    const authUserId = new URL(request.url).searchParams.get('authUserId');
    if (!authUserId) {
      return await errorResponseWithSupportCode(
        'authUserId query parameter is required',
        'Bad request',
        400,
        { stage: 'me_verification_status' }
      );
    }

    const convex = createConvexClient(config.convexUrl);
    const resolved = await resolveSubjectOrResponse(convex, config, authUserId, {
      authUserId: verified.sub,
    });

    if ('response' in resolved) {
      return resolved.response;
    }

    return getVerificationStatusResponse(convex, config, authUserId, resolved.subject._id);
  }

  async function getVerificationStatus(request: Request): Promise<Response> {
    let body: { authUserId?: string; subject?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return await errorResponseWithSupportCode('Invalid JSON body', 'Bad request', 400, {
        stage: 'verification_status',
      });
    }

    const authUserId = body.authUserId?.trim();
    if (!authUserId) {
      return await errorResponseWithSupportCode('authUserId is required', 'Bad request', 400, {
        stage: 'verification_status',
      });
    }

    const subject = parseSubjectSelector(body.subject);
    if (!subject) {
      return await errorResponseWithSupportCode(
        'subject selector is required',
        'Bad request',
        400,
        { stage: 'verification_status' }
      );
    }

    const convex = createConvexClient(config.convexUrl);
    const auth = await authenticateServiceKey(
      request,
      config,
      authUserId,
      [VERIFICATION_SCOPE],
      verifyApiKey
    );
    if ('response' in auth) {
      return auth.response;
    }

    const resolved = await resolveSubjectOrResponse(convex, config, authUserId, subject);
    if ('response' in resolved) {
      return resolved.response;
    }

    return getVerificationStatusResponse(convex, config, authUserId, resolved.subject._id);
  }

  async function checkVerification(request: Request): Promise<Response> {
    let body: { authUserId?: string; subject?: unknown; productIds?: string[] };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return await errorResponseWithSupportCode('Invalid JSON body', 'Bad request', 400, {
        stage: 'verification_check',
      });
    }

    const authUserId = body.authUserId?.trim();
    if (!authUserId) {
      return await errorResponseWithSupportCode('authUserId is required', 'Bad request', 400, {
        stage: 'verification_check',
      });
    }

    const subject = parseSubjectSelector(body.subject);
    if (!subject) {
      return await errorResponseWithSupportCode(
        'subject selector is required',
        'Bad request',
        400,
        { stage: 'verification_check' }
      );
    }
    if (!Array.isArray(body.productIds) || body.productIds.length === 0) {
      return await errorResponseWithSupportCode(
        'productIds must be a non-empty array',
        'Bad request',
        400,
        { stage: 'verification_check' }
      );
    }
    if (body.productIds.length > MAX_PRODUCT_IDS_PER_CHECK) {
      return await errorResponseWithSupportCode(
        `productIds must not exceed ${MAX_PRODUCT_IDS_PER_CHECK} items`,
        'Bad request',
        400,
        { stage: 'verification_check' }
      );
    }

    const convex = createConvexClient(config.convexUrl);
    const auth = await authenticateServiceKey(
      request,
      config,
      authUserId,
      [VERIFICATION_SCOPE],
      verifyApiKey
    );
    if ('response' in auth) {
      return auth.response;
    }

    const resolved = await resolveSubjectOrResponse(convex, config, authUserId, subject, 200);
    if ('response' in resolved) {
      return jsonResponse({
        results: body.productIds.map((productId) => ({ productId, verified: false })),
      });
    }

    const results = await Promise.all(
      body.productIds.map(async (productId) => {
        const verified = await convex.query(api.entitlements.hasActiveEntitlement, {
          apiSecret: config.convexApiSecret,
          authUserId,
          subjectId: resolved.subject._id,
          productId,
        });

        return { productId, verified: verified === true };
      })
    );

    return jsonResponse({ results });
  }

  async function verifyVerification(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return await errorResponseWithSupportCode('Invalid JSON body', 'Bad request', 400, {
        stage: 'verification_verify',
      });
    }

    const authUserId = typeof body.authUserId === 'string' ? body.authUserId.trim() : '';
    if (!authUserId) {
      return await errorResponseWithSupportCode('authUserId is required', 'Bad request', 400, {
        stage: 'verification_verify',
      });
    }

    const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
    if (!productId) {
      return await errorResponseWithSupportCode('productId is required', 'Bad request', 400, {
        stage: 'verification_verify',
      });
    }

    const selector = parseVerifyRequestSelector(body);
    if (!selector) {
      return await errorResponseWithSupportCode(
        'Exactly one identity field is required: subjectId, authUserId, discordUserId, vrchatUserId, gumroadUserId, jinxxyEmail, or jinxxyUserId',
        'Bad request',
        400,
        { stage: 'verification_verify' }
      );
    }

    const convex = createConvexClient(config.convexUrl);
    const auth = await authenticateVerifyRequest(
      request,
      config,
      convex,
      authUserId,
      verifyAccessToken,
      verifyApiKey
    );
    if ('response' in auth) {
      return auth.response;
    }

    const resolved = await resolveSubjectOrResponse(convex, config, authUserId, selector, 200);
    if ('response' in resolved) {
      return jsonResponse({
        verified: false,
        productId,
      });
    }

    const hasEntitlement = (await convex.query(api.entitlements.hasActiveEntitlement, {
      apiSecret: config.convexApiSecret,
      authUserId,
      subjectId: resolved.subject._id,
      productId,
    })) as boolean;

    return jsonResponse({
      verified: hasEntitlement,
      subjectId: resolved.subject._id,
      productId,
    });
  }

  async function resolveSubject(request: Request): Promise<Response> {
    let body: { authUserId?: string; subject?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return await errorResponseWithSupportCode('Invalid JSON body', 'Bad request', 400, {
        stage: 'subjects_resolve',
      });
    }

    const authUserId = body.authUserId?.trim();
    if (!authUserId) {
      return await errorResponseWithSupportCode('authUserId is required', 'Bad request', 400, {
        stage: 'subjects_resolve',
      });
    }

    const subjectSelector = parseSubjectSelector(body.subject);
    if (!subjectSelector) {
      return await errorResponseWithSupportCode(
        'subject selector is required',
        'Bad request',
        400,
        { stage: 'subjects_resolve' }
      );
    }

    const convex = createConvexClient(config.convexUrl);
    const auth = await authenticateServiceKey(
      request,
      config,
      authUserId,
      [SUBJECTS_SCOPE],
      verifyApiKey
    );
    if ('response' in auth) {
      return auth.response;
    }

    const resolved = await resolveSubjectOrResponse(convex, config, authUserId, subjectSelector);
    if ('response' in resolved) {
      return resolved.response;
    }

    const subjectWithAccounts = (await convex.query(api.subjects.getSubjectWithAccounts, {
      apiSecret: config.convexApiSecret,
      subjectId: resolved.subject._id,
      authUserId,
    })) as {
      externalAccounts: unknown[];
      found?: boolean;
      subject?: {
        _id: Id<'subjects'>;
        authUserId?: string;
        primaryDiscordUserId: string;
      } | null;
    } | null;

    if (!subjectWithAccounts?.found || !subjectWithAccounts.subject) {
      return await errorResponseWithSupportCode('Subject not found', 'Resource not found', 404, {
        stage: 'subjects_resolve',
        authUserId,
      });
    }

    return jsonResponse({
      found: true,
      subjectId: subjectWithAccounts.subject._id,
      authUserId: subjectWithAccounts.subject.authUserId,
      discordUserId: subjectWithAccounts.subject.primaryDiscordUserId,
      externalAccounts: subjectWithAccounts.externalAccounts,
    });
  }

  return {
    async handleRequest(request: Request, pathname: string): Promise<Response | null> {
      if (pathname === '/api/public/me/verification/status' && request.method === 'GET') {
        return getMeVerificationStatus(request);
      }
      if (pathname === '/api/public/verification/status' && request.method === 'POST') {
        return getVerificationStatus(request);
      }
      if (pathname === '/api/public/verification/check' && request.method === 'POST') {
        return checkVerification(request);
      }
      if (pathname === '/api/public/verification/verify' && request.method === 'POST') {
        return verifyVerification(request);
      }
      if (pathname === '/api/public/subjects/resolve' && request.method === 'POST') {
        return resolveSubject(request);
      }
      if (pathname.startsWith('/api/public/tenants/') && request.method === 'GET') {
        const slug = pathname.replace(/^\/api\/public\/tenants\//, '').split('/')[0];
        if (slug) {
          return getTenantBySlug(request, decodeURIComponent(slug));
        }
      }

      return null;
    },
  };
}
