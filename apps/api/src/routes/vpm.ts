import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { signDeliveryUrl } from '../../../../ops/storage-core/deliverySigning';
import { signVpmRepoToken, verifyVpmRepoToken } from '../../../../ops/storage-core/vpmToken';
import type { Auth } from '../auth';
import { createApiServiceActorBinding } from '../lib/apiActor';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';

const VPM_REPO_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
// VCC can fetch a listing before the buyer chooses Install. One hour keeps that handoff usable
// without turning the package URL into a long-lived delivery capability.
const VPM_DELIVERY_URL_TTL_MS = 60 * 60_000;

export interface VpmRouteConfig {
  apiBaseUrl: string;
  frontendBaseUrl: string;
  convexApiSecret: string;
  convexUrl: string;
  deliveryBaseUrl?: string;
  deliveryHmacKey?: string;
  vpmBaseUrl?: string;
}

interface CreateVpmRoutesOptions {
  auth: Auth;
  config: VpmRouteConfig;
}

type ActiveEntitlement = {
  catalogProductId?: Id<'product_catalog'> | null;
};

type DownloadableVersion = {
  packageId: string;
  packageName?: string;
  version: string;
  versionId: string;
};

type VpmVersionManifest = {
  author: {
    email: string;
    name: string;
  };
  displayName: string;
  name: string;
  url: string;
  version: string;
};

type VpmRepositoryPackages = Record<
  string,
  {
    versions: Record<string, VpmVersionManifest>;
  }
>;

function allowedOrigins(config: VpmRouteConfig): Set<string> {
  return new Set([new URL(config.apiBaseUrl).origin, new URL(config.frontendBaseUrl).origin]);
}

function jsonNoStore(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return Response.json(body, { ...init, headers });
}

function getConfiguredVpmDelivery(config: VpmRouteConfig): {
  deliveryBaseUrl: string;
  deliveryHmacKey: string;
  vpmBaseUrl: string;
} | null {
  const deliveryBaseUrl = config.deliveryBaseUrl?.trim();
  const deliveryHmacKey = config.deliveryHmacKey?.trim();
  const vpmBaseUrl = config.vpmBaseUrl?.trim();
  if (!deliveryBaseUrl || !deliveryHmacKey || !vpmBaseUrl) {
    return null;
  }
  try {
    for (const value of [deliveryBaseUrl, vpmBaseUrl]) {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
      }
    }
  } catch {
    return null;
  }
  return {
    deliveryBaseUrl: deliveryBaseUrl.replace(/\/+$/, ''),
    deliveryHmacKey,
    vpmBaseUrl: vpmBaseUrl.replace(/\/+$/, ''),
  };
}

function buildIndexUrl(vpmBaseUrl: string, token: string): string {
  return `${vpmBaseUrl}/api/vpm/${encodeURIComponent(token)}/index.json`;
}

// VCC custom repository handoff shape retained from the removed Backstage VPM route.
// Repository format: https://vcc.docs.vrchat.com/vpm/repos/
function buildAddRepoUrl(indexUrl: string): string {
  const addRepoUrl = new URL('vcc://vpm/addRepo');
  addRepoUrl.searchParams.set('url', indexUrl);
  return addRepoUrl.toString();
}

export function createVpmRoutes({ auth, config }: CreateVpmRoutesOptions) {
  async function mintRepoToken(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const csrfBlock = rejectCrossSiteRequest(request, allowedOrigins(config));
    if (csrfBlock) {
      return csrfBlock;
    }
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    const vpmDelivery = getConfiguredVpmDelivery(config);
    if (!vpmDelivery) {
      return Response.json({ error: 'VPM delivery is not configured' }, { status: 503 });
    }

    try {
      const signed = await signVpmRepoToken({
        authUserId: session.user.id,
        expiresAt: Date.now() + VPM_REPO_TOKEN_TTL_MS,
        key: vpmDelivery.deliveryHmacKey,
      });
      const indexUrl = buildIndexUrl(vpmDelivery.vpmBaseUrl, signed.token);
      return jsonNoStore({
        token: signed.token,
        expiresAt: signed.expiresAt,
        indexUrl,
        addRepoUrl: buildAddRepoUrl(indexUrl),
      });
    } catch (error) {
      logger.error('Failed to mint buyer VPM repository token', {
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json({ error: 'Failed to prepare VPM repository' }, { status: 500 });
    }
  }

  async function serveIndex(request: Request, token: string): Promise<Response> {
    if (request.method !== 'GET') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const vpmDelivery = getConfiguredVpmDelivery(config);
    if (!vpmDelivery) {
      return Response.json({ error: 'VPM delivery is not configured' }, { status: 503 });
    }
    const verified = await verifyVpmRepoToken({
      key: vpmDelivery.deliveryHmacKey,
      token,
    });
    if (!verified) {
      return Response.json({ error: 'Invalid or expired VPM repository token' }, { status: 401 });
    }

    try {
      const actor = await createApiServiceActorBinding({
        authUserId: verified.authUserId,
        service: 'vpm-repository',
        scopes: ['downloads:service', 'entitlements:service'],
      });
      const convex = getConvexClientFromUrl(config.convexUrl, actor);
      const entitlements: ActiveEntitlement[] = [];
      let cursor: string | undefined;
      for (;;) {
        const result = (await convex.query(api.entitlements.listByAuthUser, {
          apiSecret: config.convexApiSecret,
          authUserId: verified.authUserId,
          scope: 'subject_holder',
          status: 'active',
          limit: 100,
          ...(cursor ? { cursor } : {}),
        })) as {
          data?: ActiveEntitlement[];
          hasMore?: boolean;
          nextCursor?: string | null;
        };
        entitlements.push(...(result.data ?? []));
        if (!result.hasMore || !result.nextCursor) {
          break;
        }
        cursor = result.nextCursor;
      }

      const catalogProductIds = [
        ...new Set(
          entitlements.flatMap((entitlement) =>
            entitlement.catalogProductId ? [String(entitlement.catalogProductId)] : []
          )
        ),
      ];
      const downloadableVersions = await Promise.all(
        catalogProductIds.map(
          async (catalogProductId) =>
            (await convex.query(api.packageVersions.resolveDownloadableVersion, {
              apiSecret: config.convexApiSecret,
              catalogProductId: catalogProductId as Id<'product_catalog'>,
            })) as DownloadableVersion | null
        )
      );
      const packages = downloadableVersions.reduce<VpmRepositoryPackages>((repository, release) => {
        if (!release) {
          return repository;
        }
        const packageEntry = repository[release.packageId] ?? { versions: {} };
        repository[release.packageId] = packageEntry;
        return repository;
      }, {});

      await Promise.all(
        downloadableVersions.map(async (release) => {
          if (!release) {
            return;
          }
          const signature = await signDeliveryUrl({
            versionId: release.versionId,
            key: vpmDelivery.deliveryHmacKey,
            expiresAt: Date.now() + VPM_DELIVERY_URL_TTL_MS,
          });
          const packageEntry = packages[release.packageId];
          if (!packageEntry) {
            return;
          }
          packageEntry.versions[release.version] = {
            name: release.packageId,
            displayName: release.packageName?.trim() || release.packageId,
            version: release.version,
            author: {
              name: 'YUCP',
              email: 'contact@yucp.club',
            },
            url: `${vpmDelivery.deliveryBaseUrl}/d/${encodeURIComponent(
              release.versionId
            )}?exp=${signature.exp}&sig=${signature.sig}`,
          };
        })
      );

      const indexUrl = buildIndexUrl(vpmDelivery.vpmBaseUrl, token);
      return jsonNoStore({
        name: 'YUCP Buyer Packages',
        author: 'YUCP',
        id: 'club.yucp.buyer',
        url: indexUrl,
        packages,
      });
    } catch (error) {
      logger.error('Failed to build buyer VPM repository index', {
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json({ error: 'Failed to build VPM repository' }, { status: 500 });
    }
  }

  return { mintRepoToken, serveIndex };
}
