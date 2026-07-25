import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { signVpmRepoToken, verifyVpmRepoToken } from '../../../../ops/storage-core/vpmToken';
import type { Auth } from '../auth';
import { createApiServiceActorBinding } from '../lib/apiActor';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import {
  buildYucpAliasBootstrapVersion,
  buildYucpAliasVpmPackage,
  decodeYucpAliasArtifactDescriptor,
} from './vpmAliasPackage';
import { selectPublicImporterManifest } from './vpmImporterPackage';
import {
  fetchVpmRepositoryIndex,
  mergeVpmRepositoryPackages,
  type VpmRepositoryIndex,
  type VpmRepositoryPackages,
} from './vpmRepository';

const VPM_REPO_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const IMPORTER_MANIFEST_CACHE_MS = 5 * 60_000;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

class PublicImporterUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('The public YUCP importer is not available', options);
    this.name = 'PublicImporterUnavailableError';
  }
}

function isHttpsOrLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname))
  );
}

export interface VpmRouteConfig {
  apiBaseUrl: string;
  frontendBaseUrl: string;
  convexApiSecret: string;
  convexUrl: string;
  publicVpmIndexUrl?: string;
  trustedVpmRepositoryUrls?: string;
  vpmBaseUrl?: string;
  vpmTokenKey?: string;
}

interface CreateVpmRoutesOptions {
  auth: Auth;
  config: VpmRouteConfig;
  fetchImpl?: typeof fetch;
}

type ActiveEntitlement = {
  catalogProductId?: Id<'product_catalog'> | null;
  productId?: string | null;
  sourceProvider?: string | null;
};

type DownloadableVersion = {
  createdAt: number;
  packageId: string;
  version: string;
  versionId: string;
  vpmDependencies: Record<string, string>;
  vpmRepositories: Record<string, string>;
};

type VpmCatalogGroup = {
  aliasId?: string;
  catalogProductId: Id<'product_catalog'>;
  catalogProductIds?: Id<'product_catalog'>[];
  packageId?: string;
};

function allowedOrigins(config: VpmRouteConfig): Set<string> {
  return new Set([new URL(config.apiBaseUrl).origin, new URL(config.frontendBaseUrl).origin]);
}

function jsonNoStore(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return Response.json(body, { ...init, headers });
}

function getConfiguredVpmBaseUrl(config: VpmRouteConfig): string | null {
  const vpmBaseUrl = config.vpmBaseUrl?.trim();
  if (!vpmBaseUrl) {
    return null;
  }
  try {
    const vpmUrl = new URL(vpmBaseUrl);
    if (
      !isHttpsOrLoopbackHttp(vpmUrl) ||
      vpmUrl.username ||
      vpmUrl.password ||
      vpmUrl.search ||
      vpmUrl.hash
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return vpmBaseUrl.replace(/\/+$/, '');
}

function getConfiguredVpmRepository(config: VpmRouteConfig): {
  publicVpmIndexUrl: string;
  trustedRepositoryUrls: Set<string>;
  vpmBaseUrl: string;
  vpmTokenKey: string;
} | null {
  const publicVpmIndexUrl = config.publicVpmIndexUrl?.trim();
  const vpmBaseUrl = getConfiguredVpmBaseUrl(config);
  const vpmTokenKey = config.vpmTokenKey?.trim();
  if (!publicVpmIndexUrl || !vpmBaseUrl || !vpmTokenKey) {
    return null;
  }
  try {
    const publicIndexUrl = new URL(publicVpmIndexUrl);
    if (
      !isHttpsOrLoopbackHttp(publicIndexUrl) ||
      publicIndexUrl.username ||
      publicIndexUrl.password ||
      publicIndexUrl.hash
    ) {
      return null;
    }
  } catch {
    return null;
  }
  let trustedRepositoryValues: unknown = [];
  try {
    trustedRepositoryValues = config.trustedVpmRepositoryUrls?.trim()
      ? JSON.parse(config.trustedVpmRepositoryUrls)
      : [];
  } catch {
    return null;
  }
  if (
    !Array.isArray(trustedRepositoryValues) ||
    trustedRepositoryValues.length > 32 ||
    !trustedRepositoryValues.every((value) => typeof value === 'string')
  ) {
    return null;
  }
  const trustedRepositoryUrls = new Set<string>([new URL(publicVpmIndexUrl).toString()]);
  try {
    for (const value of trustedRepositoryValues as string[]) {
      const url = new URL(value);
      if (!isHttpsOrLoopbackHttp(url) || url.username || url.password || url.search || url.hash) {
        return null;
      }
      trustedRepositoryUrls.add(url.toString());
    }
  } catch {
    return null;
  }
  return {
    publicVpmIndexUrl,
    trustedRepositoryUrls,
    vpmBaseUrl,
    vpmTokenKey,
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

export function createVpmRoutes({ auth, config, fetchImpl = fetch }: CreateVpmRoutesOptions) {
  const repositoryCache = new Map<
    string,
    {
      expiresAt: number;
      index: VpmRepositoryIndex;
    }
  >();

  async function getRepositoryIndex(indexUrl: string): Promise<VpmRepositoryIndex> {
    const cached = repositoryCache.get(indexUrl);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.index;
    }
    let index: VpmRepositoryIndex;
    try {
      index = await fetchVpmRepositoryIndex({
        fetchImpl,
        indexUrl,
      });
    } catch (error) {
      throw new PublicImporterUnavailableError({ cause: error });
    }
    repositoryCache.set(indexUrl, {
      expiresAt: Date.now() + IMPORTER_MANIFEST_CACHE_MS,
      index,
    });
    return index;
  }

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
    const vpmRepository = getConfiguredVpmRepository(config);
    if (!vpmRepository) {
      return Response.json({ error: 'VPM delivery is not configured' }, { status: 503 });
    }

    try {
      const signed = await signVpmRepoToken({
        authUserId: session.user.id,
        expiresAt: Date.now() + VPM_REPO_TOKEN_TTL_MS,
        key: vpmRepository.vpmTokenKey,
      });
      const indexUrl = buildIndexUrl(vpmRepository.vpmBaseUrl, signed.token);
      return jsonNoStore({
        token: signed.token,
        expiresAt: signed.expiresAt,
        indexUrl,
        addRepoUrl: buildAddRepoUrl(indexUrl),
      });
    } catch (error) {
      logger.error('Failed to mint buyer VPM repository token', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return Response.json({ error: 'Failed to prepare VPM repository' }, { status: 500 });
    }
  }

  async function serveIndex(request: Request, token: string): Promise<Response> {
    if (request.method !== 'GET') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const vpmRepository = getConfiguredVpmRepository(config);
    if (!vpmRepository) {
      return Response.json({ error: 'VPM delivery is not configured' }, { status: 503 });
    }
    const verified = await verifyVpmRepoToken({
      key: vpmRepository.vpmTokenKey,
      token,
    });
    if (!verified) {
      return Response.json({ error: 'Invalid or expired VPM repository token' }, { status: 401 });
    }

    let buildPhase = 'actor';
    try {
      const actor = await createApiServiceActorBinding({
        authUserId: verified.authUserId,
        service: 'vpm-repository',
        scopes: ['downloads:service', 'entitlements:service'],
      });
      const convex = getConvexClientFromUrl(config.convexUrl, actor);
      const entitlements: ActiveEntitlement[] = [];
      let cursor: string | undefined;
      buildPhase = 'entitlements';
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
      buildPhase = 'catalog-groups';
      const resolvedGroups = await Promise.all(
        catalogProductIds.map(
          async (catalogProductId) =>
            (await convex.query(api.packageRegistry.getBuyerAccessContextByCatalogProductId, {
              apiSecret: config.convexApiSecret,
              actor,
              catalogProductId: catalogProductId as Id<'product_catalog'>,
            })) as VpmCatalogGroup | null
        )
      );
      const groups = new Map<string, VpmCatalogGroup>();
      buildPhase = 'grouping';
      for (const group of resolvedGroups) {
        if (!group) continue;
        const groupCatalogProductIds = [
          ...new Set((group.catalogProductIds ?? [group.catalogProductId]).map(String)),
        ].sort((left, right) => left.localeCompare(right));
        const identity = group.packageId
          ? `package:${group.packageId}`
          : `catalog:${groupCatalogProductIds.join('\u0000')}`;
        if (!groups.has(identity)) {
          groups.set(identity, {
            ...group,
            catalogProductIds: groupCatalogProductIds as Id<'product_catalog'>[],
          });
        }
      }
      buildPhase = 'versions';
      const downloadableGroups = await Promise.all(
        Array.from(groups.values()).map(async (group) => ({
          group,
          release: (await convex.query(api.packageVersions.resolveDownloadableVersion, {
            apiSecret: config.convexApiSecret,
            actor,
            ...(group.packageId
              ? { packageId: group.packageId }
              : { catalogProductId: group.catalogProductId }),
          })) as DownloadableVersion | null,
        }))
      );
      buildPhase = 'aliases';
      const aliases = downloadableGroups.flatMap(({ group, release }) =>
        release
          ? [
              buildYucpAliasVpmPackage({
                aliasId: group.aliasId ?? release.packageId,
                bootstrapVersion: buildYucpAliasBootstrapVersion(release.createdAt),
                catalogProductIds: (group.catalogProductIds ?? [group.catalogProductId]).map(
                  String
                ),
                vpmDependencies: release.vpmDependencies,
                vpmBaseUrl: vpmRepository.vpmBaseUrl,
              }),
            ]
          : []
      );
      const packages = aliases.reduce<VpmRepositoryPackages>((repository, alias) => {
        repository[alias.packageId] = {
          versions: {
            [alias.manifest.version]: alias.manifest,
          },
        };
        return repository;
      }, {});
      if (aliases.length > 0) {
        buildPhase = 'importer';
        const publicIndex = await getRepositoryIndex(vpmRepository.publicVpmIndexUrl);
        try {
          selectPublicImporterManifest(publicIndex);
        } catch (error) {
          throw new PublicImporterUnavailableError({ cause: error });
        }
        mergeVpmRepositoryPackages(packages, publicIndex.packages);

        buildPhase = 'dependency-repositories';
        const dependencyRepositoryUrls = [
          ...new Set(
            downloadableGroups.flatMap(({ release }) =>
              release ? Object.values(release.vpmRepositories) : []
            )
          ),
        ].sort((left, right) => left.localeCompare(right));
        for (const repositoryUrl of dependencyRepositoryUrls) {
          const normalizedUrl = new URL(repositoryUrl).toString();
          if (!vpmRepository.trustedRepositoryUrls.has(normalizedUrl)) {
            throw new Error('A package release references an untrusted VPM repository');
          }
          const dependencyIndex = await getRepositoryIndex(normalizedUrl);
          mergeVpmRepositoryPackages(packages, dependencyIndex.packages);
        }
      }

      buildPhase = 'response';
      const indexUrl = buildIndexUrl(vpmRepository.vpmBaseUrl, token);
      return jsonNoStore({
        name: 'YUCP Buyer Packages',
        author: 'YUCP',
        id: 'club.yucp.buyer',
        url: indexUrl,
        packages,
      });
    } catch (error) {
      if (error instanceof PublicImporterUnavailableError) {
        logger.warn('Public YUCP importer is unavailable for the buyer VPM index', {
          errorName: error.name,
        });
        return Response.json(
          { error: 'The public YUCP importer is not available' },
          { status: 503 }
        );
      }
      logger.error('Failed to build buyer VPM repository index', {
        phase: buildPhase,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return Response.json({ error: 'Failed to build VPM repository' }, { status: 500 });
    }
  }

  async function serveAliasPackage(
    request: Request,
    artifactDescriptor: string,
    version: string
  ): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const vpmBaseUrl = getConfiguredVpmBaseUrl(config);
    if (!vpmBaseUrl) {
      return Response.json({ error: 'VPM delivery is not configured' }, { status: 503 });
    }
    try {
      const descriptor = decodeYucpAliasArtifactDescriptor(artifactDescriptor);
      if (version !== descriptor.bootstrapVersion) {
        return Response.json({ error: 'VPM alias package not found' }, { status: 404 });
      }
      const built = buildYucpAliasVpmPackage({
        ...descriptor,
        vpmBaseUrl,
      });
      const headers = new Headers({
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Disposition': `attachment; filename="${built.packageId}-${version}.zip"`,
        'Content-Length': String(built.bytes.byteLength),
        'Content-Type': 'application/zip',
        ETag: `"${built.zipSha256}"`,
      });
      const responseBody = request.method === 'HEAD' ? null : Uint8Array.from(built.bytes).buffer;
      return new Response(responseBody, {
        status: 200,
        headers,
      });
    } catch {
      return Response.json({ error: 'VPM alias package not found' }, { status: 404 });
    }
  }

  return { mintRepoToken, serveAliasPackage, serveIndex };
}
