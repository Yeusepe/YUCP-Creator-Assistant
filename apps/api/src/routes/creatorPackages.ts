import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { Auth } from '../auth';
import { createAuthUserActorBinding } from '../lib/apiActor';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';

export interface CreatorPackageConfig {
  apiBaseUrl: string;
  frontendBaseUrl: string;
  convexApiSecret: string;
  convexUrl: string;
}

interface CreateCreatorPackageRoutesOptions {
  auth: Auth;
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
  aliases?: string[];
  canArchive: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canonicalSlug?: string;
  catalogTiers: CreatorCatalogTierSource[];
  createdAt: number;
  deleteBlockedReason?: string;
  displayName?: string;
  productId: string;
  provider: string;
  providerProductRef: string;
  status: 'active' | 'archived';
  supportsAutoDiscovery: boolean;
  thumbnailUrl?: string;
  updatedAt: number;
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
    aliases: product.aliases,
    canonicalSlug: product.canonicalSlug,
    catalogTiers: product.catalogTiers.map(serializeCreatorCatalogTier),
    displayName: product.displayName,
    thumbnailUrl: product.thumbnailUrl,
    productId: product.productId,
    provider: product.provider,
    providerProductRef: product.providerProductRef,
    status: product.status,
    supportsAutoDiscovery: product.supportsAutoDiscovery,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    canArchive: product.canArchive,
    canRestore: product.canRestore,
    canDelete: product.canDelete,
    deleteBlockedReason: product.deleteBlockedReason,
  };
}

export function createCreatorPackageRoutes({ auth, config }: CreateCreatorPackageRoutesOptions) {
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

  return { getPackage, listPackages };
}
