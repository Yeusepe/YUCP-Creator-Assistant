import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { Auth } from '../auth';
import { createAuthUserActorBinding } from '../lib/apiActor';
import {
  CatalogControlClientError,
  type CatalogControlPort,
  type CatalogVersionListControlPort,
} from '../lib/catalogControlClient';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import { RequestBodyError, readJsonObjectBodyWithLimit } from '../lib/requestBody';

const TRACEPARENT_PATTERN = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;
const EDITION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const EDITION_BODY_MAX_BYTES = 16 * 1024;
const EDITION_TARGET_LIMIT = 128;
const PUBLIC_LINK_BODY_MAX_BYTES = 2 * 1024;

export interface CreatorPackageConfig {
  apiBaseUrl: string;
  frontendBaseUrl: string;
  convexApiSecret: string;
  convexUrl: string;
}

interface CreateCreatorPackageRoutesOptions {
  auth: Auth;
  catalogControl: (CatalogControlPort & CatalogVersionListControlPort) | null;
  config: CreatorPackageConfig;
}

function allowedOrigins(config: CreatorPackageConfig): Set<string> {
  return new Set([new URL(config.apiBaseUrl).origin, new URL(config.frontendBaseUrl).origin]);
}

function jsonNoStore(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return Response.json(body, {
    ...init,
    headers,
  });
}

function noStore(response: Response): Response {
  const next = new Response(response.body, response);
  next.headers.set('Cache-Control', 'private, no-store');
  return next;
}

function optionalSearchParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value || undefined;
}

function parseLimit(url: URL): number | Response | undefined {
  const value = optionalSearchParam(url, 'limit');
  if (value === undefined) {
    return undefined;
  }

  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return jsonNoStore({ error: 'limit must be an integer between 1 and 100' }, { status: 400 });
  }
  return limit;
}

function parseConfigured(url: URL): boolean | Response {
  const value = optionalSearchParam(url, 'configured');
  if (value === undefined || value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return jsonNoStore({ error: 'configured must be true or false' }, { status: 400 });
}

function parseVersionPage(url: URL):
  | {
      cursor?: string;
      limit: number;
    }
  | Response {
  const allowed = new Set(['cursor', 'limit']);
  const keys = Array.from(url.searchParams.keys());
  if (
    keys.some((key) => !allowed.has(key)) ||
    url.searchParams.getAll('cursor').length > 1 ||
    url.searchParams.getAll('limit').length > 1
  ) {
    return jsonNoStore({ error: 'Version page parameters are invalid' }, { status: 400 });
  }
  const parsedLimit = parseLimit(url);
  if (parsedLimit instanceof Response) {
    return parsedLimit;
  }
  const cursor = optionalSearchParam(url, 'cursor');
  if (
    cursor &&
    (Buffer.byteLength(cursor, 'utf8') > 2 * 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
  ) {
    return jsonNoStore({ error: 'Version page cursor is invalid' }, { status: 400 });
  }
  return {
    ...(cursor ? { cursor } : {}),
    limit: parsedLimit ?? 50,
  };
}

type CreatorCatalogTierSource = {
  _id: string;
  amountCents?: number;
  catalogProductId?: string;
  createdAt: number;
  currency?: string;
  description?: string;
  displayName: string;
  provider: string;
  providerTierRef: string;
  status: 'active' | 'archived';
  updatedAt: number;
};

type CreatorPackageProductSource = {
  _id: string;
  accessRole: 'owner' | 'collaborator';
  aliasId?: string;
  aliases?: string[];
  canArchive: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canonicalSlug?: string;
  catalogProductIds?: string[];
  catalogTiers: CreatorCatalogTierSource[];
  creatorAuthUserId: string;
  creatorDisplayName?: string;
  createdAt: number;
  deleteBlockedReason?: string;
  displayName?: string;
  packageId?: string;
  packageName?: string;
  publicCreatorSlug?: string;
  publicSlug?: string;
  packageAssociationUpdatedAt?: number;
  packageEditions?: CreatorPackageEditionSource[];
  productId: string;
  provider: string;
  providerProductRef: string;
  status: 'active' | 'archived';
  supportsAutoDiscovery: boolean;
  thumbnailUrl?: string;
  storefronts?: CreatorPackageStorefrontSource[];
  updatedAt: number;
};

type CreatorPackageEditionSource = {
  catalogProductIds: string[];
  catalogTierIds: string[];
  createdAt: number;
  displayName: string;
  editionId: string;
  priority: number;
  status: 'active' | 'archived';
  updatedAt: number;
};

type CreatorPackageStorefrontSource = {
  catalogProductId: string;
  canonicalSlug?: string;
  displayName?: string;
  productId: string;
  provider: string;
  providerProductRef: string;
  thumbnailUrl?: string;
};

function serializeCreatorCatalogTier(tier: CreatorCatalogTierSource) {
  return {
    _id: tier._id,
    catalogProductId: tier.catalogProductId,
    provider: tier.provider,
    providerTierRef: tier.providerTierRef,
    displayName: tier.displayName,
    description: tier.description,
    amountCents: tier.amountCents,
    currency: tier.currency,
    status: tier.status,
    createdAt: tier.createdAt,
    updatedAt: tier.updatedAt,
  };
}

function serializeCreatorPackageProduct(product: CreatorPackageProductSource) {
  return {
    _id: product._id,
    accessRole: product.accessRole,
    aliasId: product.aliasId,
    aliases: product.aliases,
    canonicalSlug: product.canonicalSlug,
    catalogProductIds: product.catalogProductIds,
    catalogTiers: product.catalogTiers.map(serializeCreatorCatalogTier),
    creatorAuthUserId: product.creatorAuthUserId,
    creatorDisplayName: product.creatorDisplayName,
    displayName: product.displayName,
    thumbnailUrl: product.thumbnailUrl,
    packageId: product.packageId,
    packageName: product.packageName,
    publicCreatorSlug: product.publicCreatorSlug,
    publicSlug: product.publicSlug,
    packageAssociationUpdatedAt: product.packageAssociationUpdatedAt,
    packageEditions: product.packageEditions,
    productId: product.productId,
    provider: product.provider,
    providerProductRef: product.providerProductRef,
    status: product.status,
    storefronts: product.storefronts,
    supportsAutoDiscovery: product.supportsAutoDiscovery,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    canArchive: product.canArchive,
    canRestore: product.canRestore,
    canDelete: product.canDelete,
    deleteBlockedReason: product.deleteBlockedReason,
  };
}

export function createCreatorPackageRoutes({
  auth,
  catalogControl,
  config,
}: CreateCreatorPackageRoutesOptions) {
  async function requireSessionActor(request: Request): Promise<
    | {
        actor: Awaited<ReturnType<typeof createAuthUserActorBinding>>;
        authUserId: string;
        convex: ReturnType<typeof getConvexClientFromUrl>;
      }
    | Response
  > {
    const session = await auth.getSession(request);
    if (!session) {
      return jsonNoStore({ error: 'Authentication required' }, { status: 401 });
    }

    const csrfBlock = rejectCrossSiteRequest(request, allowedOrigins(config));
    if (csrfBlock) {
      return noStore(csrfBlock);
    }

    const actor = await createAuthUserActorBinding({
      authUserId: session.user.id,
      source: 'session',
    });

    return {
      actor,
      authUserId: session.user.id,
      convex: getConvexClientFromUrl(config.convexUrl, actor),
    };
  }

  async function listPackages(request: Request): Promise<Response> {
    if (request.method !== 'GET') {
      return jsonNoStore({ error: 'Method not allowed' }, { status: 405 });
    }

    const authorized = await requireSessionActor(request);
    if (authorized instanceof Response) {
      return authorized;
    }

    const url = new URL(request.url);
    const limit = parseLimit(url);
    if (limit instanceof Response) {
      return limit;
    }
    const configuredOnly = parseConfigured(url);
    if (configuredOnly instanceof Response) {
      return configuredOnly;
    }
    const cursor = optionalSearchParam(url, 'cursor');
    const provider = optionalSearchParam(url, 'provider');
    const status = optionalSearchParam(url, 'status');

    try {
      const page = await authorized.convex.query(api.packageRegistry.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: authorized.actor,
        authUserId: authorized.authUserId,
        configuredOnly,
        ...(provider ? { provider } : {}),
        ...(status ? { status } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit } : {}),
      });
      return jsonNoStore({
        data: page.data.map(serializeCreatorPackageProduct),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      logger.error('Creator package list query failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonNoStore({ error: 'Failed to load creator packages' }, { status: 500 });
    }
  }

  async function listVersions(
    request: Request,
    packageId: string,
    editionId: string
  ): Promise<Response> {
    if (request.method !== 'GET') {
      return jsonNoStore({ error: 'Method not allowed' }, { status: 405 });
    }
    const authorized = await requireSessionActor(request);
    if (authorized instanceof Response) {
      return authorized;
    }
    if (!EDITION_ID_PATTERN.test(editionId)) {
      return jsonNoStore({ error: 'Package edition ID is invalid' }, { status: 400 });
    }
    const versionPage = parseVersionPage(new URL(request.url));
    if (versionPage instanceof Response) {
      return versionPage;
    }
    if (!catalogControl) {
      return jsonNoStore({ errorCode: 'PACKAGE_VERSION_LIST_UNAVAILABLE' }, { status: 503 });
    }

    try {
      const scope = await authorized.convex.query(
        api.packageEditions.getManagementScopeForCreator,
        {
          apiSecret: config.convexApiSecret,
          actor: authorized.actor,
          authUserId: authorized.authUserId,
          editionId,
          packageId,
        }
      );
      if (!scope) {
        return jsonNoStore({ errorCode: 'PACKAGE_EDITION_NOT_FOUND' }, { status: 404 });
      }
      const candidateTraceparent = request.headers.get('traceparent');
      const traceparent =
        candidateTraceparent && TRACEPARENT_PATTERN.test(candidateTraceparent)
          ? candidateTraceparent
          : undefined;
      const page = await catalogControl.listVersions({
        ...versionPage,
        editionId,
        packageId,
        ...(traceparent ? { traceparent } : {}),
      });
      return jsonNoStore(page);
    } catch (error) {
      if (error instanceof CatalogControlClientError && error.status === 400) {
        return jsonNoStore({ errorCode: 'PACKAGE_VERSION_PAGE_INVALID' }, { status: 400 });
      }
      logger.error('Creator package version page query failed', {
        editionId,
        error: error instanceof Error ? error.name : 'unknown_error',
        packageId,
      });
      return jsonNoStore({ errorCode: 'PACKAGE_VERSION_LIST_FAILED' }, { status: 502 });
    }
  }

  async function getPackage(request: Request, catalogProductId: string): Promise<Response> {
    if (request.method !== 'GET') {
      return jsonNoStore({ error: 'Method not allowed' }, { status: 405 });
    }

    const authorized = await requireSessionActor(request);
    if (authorized instanceof Response) {
      return authorized;
    }

    try {
      const product = await authorized.convex.query(api.packageRegistry.getByIdForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: authorized.actor,
        authUserId: authorized.authUserId,
        catalogProductId: catalogProductId as Id<'product_catalog'>,
      });
      if (!product) {
        return jsonNoStore({ error: 'Package not found' }, { status: 404 });
      }
      return jsonNoStore(serializeCreatorPackageProduct(product));
    } catch (error) {
      logger.error('Creator package detail query failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonNoStore({ error: 'Failed to load creator package' }, { status: 500 });
    }
  }

  async function deleteVersion(
    request: Request,
    packageId: string,
    editionId: string,
    versionId: string
  ): Promise<Response> {
    if (request.method !== 'DELETE') {
      return jsonNoStore({ error: 'Method not allowed' }, { status: 405 });
    }

    const authorized = await requireSessionActor(request);
    if (authorized instanceof Response) {
      return authorized;
    }
    if (!EDITION_ID_PATTERN.test(editionId)) {
      return jsonNoStore({ error: 'Package edition ID is invalid' }, { status: 400 });
    }
    if (!catalogControl) {
      return jsonNoStore({ errorCode: 'PACKAGE_VERSION_DELETE_UNAVAILABLE' }, { status: 503 });
    }

    try {
      const scope = await authorized.convex.query(
        api.packageEditions.getManagementScopeForCreator,
        {
          apiSecret: config.convexApiSecret,
          actor: authorized.actor,
          authUserId: authorized.authUserId,
          editionId,
          packageId,
        }
      );
      if (!scope) {
        return jsonNoStore({ errorCode: 'PACKAGE_VERSION_NOT_FOUND' }, { status: 404 });
      }

      const candidateTraceparent = request.headers.get('traceparent');
      const traceparent =
        candidateTraceparent && TRACEPARENT_PATTERN.test(candidateTraceparent)
          ? candidateTraceparent
          : undefined;
      const deleted = await catalogControl.deleteVersion({
        editionId,
        packageId,
        versionId,
        ...(traceparent ? { traceparent } : {}),
      });
      return jsonNoStore(deleted);
    } catch (error) {
      if (error instanceof CatalogControlClientError) {
        if (error.errorCode === 'PACKAGE_VERSION_NOT_FOUND') {
          return jsonNoStore({ errorCode: error.errorCode }, { status: 404 });
        }
        if (error.errorCode === 'PACKAGE_VERSION_DELETE_BLOCKED') {
          return jsonNoStore({ errorCode: error.errorCode }, { status: 409 });
        }
      }
      logger.error('Creator package version deletion failed', {
        editionId,
        error: error instanceof Error ? error.name : 'unknown_error',
        packageId,
        versionId,
      });
      return jsonNoStore({ errorCode: 'PACKAGE_VERSION_DELETE_FAILED' }, { status: 502 });
    }
  }

  async function getVersionStatus(
    request: Request,
    packageId: string,
    editionId: string,
    versionId: string
  ): Promise<Response> {
    if (request.method !== 'GET') {
      return jsonNoStore({ error: 'Method not allowed' }, { status: 405 });
    }

    const authorized = await requireSessionActor(request);
    if (authorized instanceof Response) {
      return authorized;
    }
    if (!EDITION_ID_PATTERN.test(editionId)) {
      return jsonNoStore({ error: 'Package edition ID is invalid' }, { status: 400 });
    }
    if (!catalogControl) {
      return jsonNoStore({ errorCode: 'PACKAGE_VERSION_STATUS_UNAVAILABLE' }, { status: 503 });
    }

    try {
      const scope = await authorized.convex.query(
        api.packageEditions.getManagementScopeForCreator,
        {
          apiSecret: config.convexApiSecret,
          actor: authorized.actor,
          authUserId: authorized.authUserId,
          editionId,
          packageId,
        }
      );
      if (!scope) {
        return jsonNoStore({ errorCode: 'PACKAGE_VERSION_NOT_FOUND' }, { status: 404 });
      }

      const candidateTraceparent = request.headers.get('traceparent');
      const traceparent =
        candidateTraceparent && TRACEPARENT_PATTERN.test(candidateTraceparent)
          ? candidateTraceparent
          : undefined;
      const status = await catalogControl.getVersionStatus({
        editionId,
        packageId,
        versionId,
        ...(traceparent ? { traceparent } : {}),
      });
      return jsonNoStore(status);
    } catch (error) {
      if (
        error instanceof CatalogControlClientError &&
        error.errorCode === 'PACKAGE_VERSION_NOT_FOUND'
      ) {
        return jsonNoStore({ errorCode: error.errorCode }, { status: 404 });
      }
      logger.error('Creator package version status query failed', {
        editionId,
        error: error instanceof Error ? error.name : 'unknown_error',
        packageId,
        versionId,
      });
      return jsonNoStore({ errorCode: 'PACKAGE_VERSION_STATUS_FAILED' }, { status: 502 });
    }
  }

  async function manageEdition(
    request: Request,
    catalogProductId: string,
    editionId: string
  ): Promise<Response> {
    if (request.method !== 'PUT' && request.method !== 'DELETE') {
      return jsonNoStore({ error: 'Method not allowed' }, { status: 405 });
    }

    const authorized = await requireSessionActor(request);
    if (authorized instanceof Response) {
      return authorized;
    }
    if (!EDITION_ID_PATTERN.test(editionId)) {
      return jsonNoStore(
        { error: 'Edition ID must use lowercase letters, numbers, and hyphens' },
        { status: 400 }
      );
    }
    if (request.method === 'DELETE' && editionId === 'standard') {
      return jsonNoStore({ error: 'The standard edition is always available' }, { status: 409 });
    }

    try {
      const product = await authorized.convex.query(api.packageRegistry.getByIdForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: authorized.actor,
        authUserId: authorized.authUserId,
        catalogProductId: catalogProductId as Id<'product_catalog'>,
      });
      if (!product?.packageId) {
        return jsonNoStore({ error: 'Package not found' }, { status: 404 });
      }

      if (request.method === 'DELETE') {
        await authorized.convex.mutation(api.packageEditions.archiveForCreator, {
          apiSecret: config.convexApiSecret,
          actor: authorized.actor,
          authUserId: product.creatorAuthUserId ?? authorized.authUserId,
          editionId,
          packageId: product.packageId,
        });
        return jsonNoStore({ archived: true, editionId });
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonObjectBodyWithLimit(request, EDITION_BODY_MAX_BYTES);
      } catch (error) {
        if (error instanceof RequestBodyError) {
          return jsonNoStore({ error: error.message }, { status: error.status });
        }
        throw error;
      }
      const candidate = body;
      const displayName =
        typeof candidate.displayName === 'string' ? candidate.displayName.trim() : '';
      const priority = candidate.priority;
      const rawCatalogProductIds = Array.isArray(candidate.catalogProductIds)
        ? candidate.catalogProductIds
        : [];
      const rawCatalogTierIds = Array.isArray(candidate.catalogTierIds)
        ? candidate.catalogTierIds
        : [];
      if (
        !displayName ||
        displayName.length > 80 ||
        !Number.isSafeInteger(priority) ||
        (priority as number) < -10_000 ||
        (priority as number) > 10_000 ||
        rawCatalogProductIds.length === 0 ||
        rawCatalogProductIds.length > EDITION_TARGET_LIMIT ||
        rawCatalogTierIds.length > EDITION_TARGET_LIMIT ||
        !rawCatalogProductIds.every((value) => typeof value === 'string' && value.length > 0) ||
        !rawCatalogTierIds.every((value) => typeof value === 'string' && value.length > 0)
      ) {
        return jsonNoStore({ error: 'Edition details are invalid' }, { status: 400 });
      }
      const catalogProductIds = [...new Set(rawCatalogProductIds)] as string[];
      const catalogTierIds = [...new Set(rawCatalogTierIds)] as string[];

      await authorized.convex.mutation(api.packageEditions.upsertForCreator, {
        apiSecret: config.convexApiSecret,
        actor: authorized.actor,
        authUserId: product.creatorAuthUserId ?? authorized.authUserId,
        catalogProductIds: catalogProductIds as Array<Id<'product_catalog'>>,
        catalogTierIds: catalogTierIds as Array<Id<'catalog_tiers'>>,
        displayName,
        editionId,
        packageId: product.packageId,
        priority: priority as number,
      });
      return jsonNoStore({ editionId, saved: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /Package ownership required|Catalog product ownership required|Catalog tier ownership required|Unauthorized/.test(
          message
        )
      ) {
        return jsonNoStore({ error: 'You cannot manage this package edition' }, { status: 403 });
      }
      if (/not found/i.test(message)) {
        return jsonNoStore({ error: 'Package edition not found' }, { status: 404 });
      }
      logger.error('Creator package edition mutation failed', {
        catalogProductId,
        editionId,
        error: error instanceof Error ? error.name : 'unknown_error',
      });
      return jsonNoStore({ error: 'Failed to save package edition' }, { status: 500 });
    }
  }

  async function manageStorefrontBinding(
    request: Request,
    catalogProductId: string,
    targetCatalogProductId: string
  ): Promise<Response> {
    if (request.method !== 'PUT' && request.method !== 'DELETE') {
      return jsonNoStore({ error: 'Method not allowed' }, { status: 405 });
    }
    const authorized = await requireSessionActor(request);
    if (authorized instanceof Response) {
      return authorized;
    }
    try {
      const product = await authorized.convex.query(api.packageRegistry.getByIdForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: authorized.actor,
        authUserId: authorized.authUserId,
        catalogProductId: catalogProductId as Id<'product_catalog'>,
      });
      if (!product?.packageId) {
        return jsonNoStore({ error: 'Package not found' }, { status: 404 });
      }
      const args = {
        apiSecret: config.convexApiSecret,
        actor: authorized.actor,
        authUserId: product.creatorAuthUserId ?? authorized.authUserId,
        catalogProductId: targetCatalogProductId as Id<'product_catalog'>,
        packageId: product.packageId,
      };
      const result =
        request.method === 'PUT'
          ? await authorized.convex.mutation(api.packageRegistry.bindCatalogProductForCreator, args)
          : await authorized.convex.mutation(
              api.packageRegistry.unbindCatalogProductForCreator,
              args
            );
      return jsonNoStore(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /ownership required|another package|not linked to this package|Unauthorized/.test(message)
      ) {
        return jsonNoStore({ error: 'You cannot change this storefront link' }, { status: 403 });
      }
      if (/must keep at least one linked storefront/.test(message)) {
        return jsonNoStore({ error: 'A package must keep one linked storefront' }, { status: 409 });
      }
      logger.error('Creator package storefront link mutation failed', {
        catalogProductId,
        error: error instanceof Error ? error.name : 'unknown_error',
        targetCatalogProductId,
      });
      return jsonNoStore({ error: 'Failed to change the storefront link' }, { status: 500 });
    }
  }

  async function managePublicLink(request: Request, packageId: string): Promise<Response> {
    if (request.method !== 'PUT') {
      return jsonNoStore({ error: 'Method not allowed' }, { status: 405 });
    }
    const authorized = await requireSessionActor(request);
    if (authorized instanceof Response) {
      return authorized;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonObjectBodyWithLimit(request, PUBLIC_LINK_BODY_MAX_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return jsonNoStore({ error: error.message }, { status: error.status });
      }
      throw error;
    }
    if (typeof body.publicSlug !== 'string' || !body.publicSlug.trim()) {
      return jsonNoStore({ error: 'publicSlug is required' }, { status: 400 });
    }

    try {
      const result = await authorized.convex.mutation(api.packageRegistry.updatePublicNamespace, {
        apiSecret: config.convexApiSecret,
        actor: authorized.actor,
        authUserId: authorized.authUserId,
        packageId,
        publicSlug: body.publicSlug,
      });
      return jsonNoStore(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not available|ownership|Unauthorized/i.test(message)) {
        return jsonNoStore({ error: 'You cannot manage this package' }, { status: 403 });
      }
      if (/already in use/i.test(message)) {
        return jsonNoStore(
          { error: 'That public product path is already in use' },
          { status: 409 }
        );
      }
      if (/must use lowercase/i.test(message)) {
        return jsonNoStore({ error: message }, { status: 400 });
      }
      logger.error('Creator package public link mutation failed', {
        error: error instanceof Error ? error.name : 'unknown_error',
        packageId,
      });
      return jsonNoStore({ error: 'Failed to save the public product link' }, { status: 500 });
    }
  }

  return {
    deleteVersion,
    getPackage,
    getVersionStatus,
    listPackages,
    listVersions,
    manageEdition,
    managePublicLink,
    manageStorefrontBinding,
  };
}
