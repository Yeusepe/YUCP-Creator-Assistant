import { createHash } from 'node:crypto';
import { parseTraceparent, timingSafeStringEqual } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import publicImporterReleaseLedger from '../../../../ops/importer/public-importer-releases.json';
import type { Auth } from '../auth';
import { createApiServiceActorBinding, createAuthUserActorBinding } from '../lib/apiActor';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import {
  buildPrivateVpmBaseUrl,
  createPrivateVpmSlugCandidates,
  normalizePrivateVpmRootDomain,
  type PrivateVpmDomainProvisioner,
} from '../lib/privateVpmDomain';
import { RequestBodyError, readJsonObjectBodyWithLimit } from '../lib/requestBody';
import type {
  VpmAliasArtifactReference,
  VpmAliasArtifactStore,
} from '../lib/vpmAliasArtifactStore';
import { buildPublicVpmRepositoryAccess } from '../lib/vpmPublicRepository';
import {
  buildYucpAliasVpmPackage,
  type YucpAliasPackageMediaInput,
  type YucpAliasPackageMediaReference,
} from './vpmAliasPackage';
import {
  assertPublicImporterIndexMatchesReleaseLedger,
  assertPublicImporterVersionsImmutable,
  type PublicImporterReleaseLedger,
  selectPublicImporterManifest,
} from './vpmImporterPackage';
import {
  fetchVpmRepositoryIndex,
  mergeVpmRepositoryPackages,
  type VpmRepositoryIndex,
  type VpmRepositoryPackages,
} from './vpmRepository';

const IMPORTER_MANIFEST_CACHE_MS = 5 * 60_000;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const CREATOR_VPM_LINK_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CREATOR_PRESENTATION_BODY_MAX_BYTES = 16 * 1024;
const CREATOR_PACKAGE_NAME_MAX_BYTES = 120;

class PublicImporterUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('The public YUCP importer is not available', options);
    this.name = 'PublicImporterUnavailableError';
  }
}

class PublicBootstrapMediaUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Public bootstrap media is unavailable', options);
    this.name = 'PublicBootstrapMediaUnavailableError';
  }
}

class PublicAliasPublicationUnavailableError extends Error {
  constructor(message = 'VPM alias publication storage is unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublicAliasPublicationUnavailableError';
  }
}

class PrivateVpmDomainUnavailableError extends Error {
  constructor(message = 'Creator private VPM domain is unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'PrivateVpmDomainUnavailableError';
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
  internalRpcSharedSecret?: string;
  convexApiSecret: string;
  convexUrl: string;
  publicVpmIndexUrl?: string;
  publicImporterReleaseLedger?: PublicImporterReleaseLedger;
  privateVpmRootDomain?: string;
  vpmBaseUrl?: string;
}

interface CreateVpmRoutesOptions {
  aliasArtifactStore?: VpmAliasArtifactStore;
  auth: Auth;
  bootstrapMediaReader?: VpmBootstrapMediaReader;
  config: VpmRouteConfig;
  fetchImpl?: typeof fetch;
  privateDomainProvisioner?: PrivateVpmDomainProvisioner;
}

type PublicBootstrapPresentation = {
  bootstrapMedia?: YucpAliasPackageMediaReference[];
  packageMetadata?: {
    author?: string;
    description?: string;
    packageName?: string;
    tagline?: string;
  };
};

export interface VpmBootstrapMediaReader {
  readExact(reference: YucpAliasPackageMediaReference): Promise<Uint8Array>;
}

type CreatorVpmProduct = {
  _id: Id<'product_catalog'>;
  aliasId?: string;
  catalogProductId?: Id<'product_catalog'>;
  catalogProductIds?: Id<'product_catalog'>[];
  creatorAuthUserId?: string;
  displayName?: string;
  packageId?: string;
  packageName?: string;
};

type VpmAliasPresentation = {
  artifactBaseUrl: string;
  artifactBucketName?: string;
  authorName: string;
  channel: string;
  description: string;
  media: YucpAliasPackageMediaReference[];
  minImporterVersion: string;
  packageId: string;
  packageName: string;
  presentationFingerprintSha256: string;
  tagline?: string;
  unityVersion: string;
};

type VpmAliasPublicationReservation = {
  bootstrapVersion: string;
  channel: string;
  created: boolean;
  packageId: string;
  presentationFingerprintSha256: string;
  publicationId: string;
  revision: number;
  status: 'PREPARING' | 'PUBLISHED';
};

type PublishedVpmAlias = {
  aliasPackageId: string;
  artifact: VpmAliasArtifactReference;
  bootstrapVersion: string;
  channel: string;
  contractVersion: 1;
  createdAt: number;
  packageId: string;
  presentationFingerprintSha256: string;
  publicationId: string;
  publishedAt: number;
  repositoryManifestJson: string;
  repositoryManifestSha256: string;
  revision: number;
  status: 'PUBLISHED';
};

type ActiveCreatorVpmLink = {
  createdAt: number;
  creatorSlug: string;
  linkId: string;
  packageId: string;
  status: 'active';
};

function allowedOrigins(config: VpmRouteConfig): Set<string> {
  return new Set([new URL(config.apiBaseUrl).origin, new URL(config.frontendBaseUrl).origin]);
}

function jsonNoStore(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return Response.json(body, { ...init, headers });
}

function jsonNoCache(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store');
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

function getConfiguredPrivateVpmRootDomain(config: VpmRouteConfig): string | null {
  return normalizePrivateVpmRootDomain(config.privateVpmRootDomain);
}

function getPublicRequestHostname(request: Request, config: VpmRouteConfig): string {
  const expectedSecret = config.internalRpcSharedSecret?.trim();
  const providedSecret = request.headers.get('x-internal-service-secret')?.trim() ?? '';
  const claimedHost = request.headers.get('x-yucp-public-host')?.trim().toLowerCase();
  if (
    expectedSecret &&
    claimedHost &&
    request.headers.get('x-internal-service') === 'web' &&
    timingSafeStringEqual(providedSecret, expectedSecret)
  ) {
    try {
      const claimedUrl = new URL(`https://${claimedHost}`);
      if (
        claimedUrl.host === claimedHost &&
        claimedUrl.pathname === '/' &&
        !claimedUrl.username &&
        !claimedUrl.password
      ) {
        return claimedUrl.hostname;
      }
    } catch {
      return new URL(request.url).hostname;
    }
  }
  return new URL(request.url).hostname;
}

function getConfiguredVpmRepository(config: VpmRouteConfig): {
  publicVpmIndexUrl: string;
  vpmBaseUrl: string;
} | null {
  const publicVpmIndexUrl = config.publicVpmIndexUrl?.trim();
  const vpmBaseUrl = getConfiguredVpmBaseUrl(config);
  if (!publicVpmIndexUrl || !vpmBaseUrl) {
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
  return {
    publicVpmIndexUrl,
    vpmBaseUrl,
  };
}

function createCreatorLinkId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export function createVpmRoutes({
  aliasArtifactStore,
  auth,
  bootstrapMediaReader,
  config,
  fetchImpl = fetch,
  privateDomainProvisioner,
}: CreateVpmRoutesOptions) {
  const repositoryCache = new Map<
    string,
    {
      expiresAt: number;
      index: VpmRepositoryIndex;
    }
  >();

  async function resolveBootstrapMedia(
    references: readonly YucpAliasPackageMediaReference[] | undefined
  ): Promise<YucpAliasPackageMediaInput[] | undefined> {
    if (!references || references.length === 0) {
      return undefined;
    }
    if (!bootstrapMediaReader) {
      throw new PublicBootstrapMediaUnavailableError();
    }
    try {
      return await Promise.all(
        references.map(async (reference) => ({
          ...reference,
          bytes: await bootstrapMediaReader.readExact(reference),
        }))
      );
    } catch (error) {
      throw new PublicBootstrapMediaUnavailableError({ cause: error });
    }
  }

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
      assertPublicImporterIndexMatchesReleaseLedger(
        index,
        config.publicImporterReleaseLedger ??
          (publicImporterReleaseLedger as PublicImporterReleaseLedger)
      );
      if (cached) {
        assertPublicImporterVersionsImmutable(
          selectPublicImporterManifest(cached.index),
          selectPublicImporterManifest(index)
        );
      }
    } catch (error) {
      throw new PublicImporterUnavailableError({ cause: error });
    }
    repositoryCache.set(indexUrl, {
      expiresAt: Date.now() + IMPORTER_MANIFEST_CACHE_MS,
      index,
    });
    return index;
  }

  function buildPublishedAliasPackages(
    publications: readonly PublishedVpmAlias[]
  ): VpmRepositoryPackages {
    const packages: VpmRepositoryPackages = {};
    let expectedAliasPackageId: string | undefined;
    for (const publication of publications) {
      let manifest: Record<string, unknown>;
      try {
        const parsed = JSON.parse(publication.repositoryManifestJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('VPM alias manifest is not an object');
        }
        manifest = parsed as Record<string, unknown>;
      } catch (error) {
        throw new Error('Published VPM alias manifest is invalid', { cause: error });
      }
      if (
        manifest.name !== publication.aliasPackageId ||
        manifest.version !== publication.bootstrapVersion ||
        manifest.zipSHA256 !== publication.artifact.sha256 ||
        typeof manifest.url !== 'string'
      ) {
        throw new Error('Published VPM alias manifest does not match its ledger record');
      }
      const manifestSha256 = createHash('sha256')
        .update(publication.repositoryManifestJson)
        .digest('hex');
      if (manifestSha256 !== publication.repositoryManifestSha256) {
        throw new Error('Published VPM alias manifest failed digest verification');
      }
      expectedAliasPackageId ??= publication.aliasPackageId;
      if (publication.aliasPackageId !== expectedAliasPackageId) {
        throw new Error('Package-scoped VPM publications contain multiple alias identities');
      }
      const packageEntry = packages[publication.aliasPackageId] ?? { versions: {} };
      if (packageEntry.versions[publication.bootstrapVersion]) {
        throw new Error('Package-scoped VPM publications contain a duplicate version');
      }
      packageEntry.versions[publication.bootstrapVersion] = manifest as never;
      packages[publication.aliasPackageId] = packageEntry;
    }
    return packages;
  }

  async function mergePublicImporter(
    packages: VpmRepositoryPackages,
    vpmRepository: NonNullable<ReturnType<typeof getConfiguredVpmRepository>>
  ): Promise<void> {
    const publicIndex = await getRepositoryIndex(vpmRepository.publicVpmIndexUrl);
    const importer = (() => {
      try {
        return selectPublicImporterManifest(publicIndex);
      } catch (error) {
        throw new PublicImporterUnavailableError({ cause: error });
      }
    })();
    mergeVpmRepositoryPackages(packages, {
      [importer.name]: {
        versions: {
          [importer.version]: importer,
        },
      },
    });
  }

  async function getCreatorPackageContext(request: Request, packageId: string) {
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const csrfBlock = rejectCrossSiteRequest(request, allowedOrigins(config));
      if (csrfBlock) {
        return csrfBlock;
      }
    }
    const actor = await createAuthUserActorBinding({
      authUserId: session.user.id,
      source: 'session',
    });
    const convex = getConvexClientFromUrl(config.convexUrl, actor);
    const product = (await convex.query(api.packageRegistry.getByPackageIdForAuthUser, {
      apiSecret: config.convexApiSecret,
      actor,
      authUserId: session.user.id,
      packageId,
    })) as CreatorVpmProduct | null;
    if (!product?.packageId || product.packageId !== packageId) {
      return Response.json({ error: 'Package not found' }, { status: 404 });
    }
    return {
      actor,
      authUserId: session.user.id,
      convex,
      product,
    };
  }

  async function ensurePackagePublication(input: {
    authUserId: string;
    creatorActor: Awaited<ReturnType<typeof createAuthUserActorBinding>>;
    creatorConvex: ReturnType<typeof getConvexClientFromUrl>;
    packageNameOverride?: string;
    product: CreatorVpmProduct;
    publicationReason?: 'link-activation' | 'presentation-update';
    traceparent?: string;
    vpmRepository: NonNullable<ReturnType<typeof getConfiguredVpmRepository>>;
  }): Promise<void> {
    if (!aliasArtifactStore || !input.product.packageId) {
      throw new PublicAliasPublicationUnavailableError();
    }
    const packageId = input.product.packageId;
    const serviceActor = await createApiServiceActorBinding({
      authUserId: input.authUserId,
      service: 'vpm-alias-publisher',
      scopes: ['downloads:service'],
    });
    const serviceConvex = getConvexClientFromUrl(config.convexUrl, serviceActor);
    let presentation = (await serviceConvex.query(
      api.vpmAliasPublications.getPresentationForService,
      {
        apiSecret: config.convexApiSecret,
        actor: serviceActor,
        packageId,
        channel: 'stable',
      }
    )) as VpmAliasPresentation | null;

    if (!presentation) {
      const releasePresentation = (await serviceConvex.query(
        api.packageVersions.resolvePublicBootstrapPresentation,
        {
          apiSecret: config.convexApiSecret,
          actor: serviceActor,
          packageId,
        }
      )) as PublicBootstrapPresentation | null;
      if (!releasePresentation) {
        throw new PublicAliasPublicationUnavailableError(
          'Package has no public bootstrap presentation'
        );
      }
      const creatorProfile = (await serviceConvex.query(api.creatorProfiles.getCreatorProfile, {
        apiSecret: config.convexApiSecret,
        authUserId: input.authUserId,
      })) as { name?: string } | null;
      const packageName =
        input.packageNameOverride ||
        releasePresentation.packageMetadata?.packageName?.trim() ||
        input.product.packageName?.trim() ||
        input.product.displayName?.trim() ||
        input.product.aliasId?.trim() ||
        packageId;
      await input.creatorConvex.mutation(
        api.vpmAliasPublications.seedPresentationIfMissingForCreator,
        {
          apiSecret: config.convexApiSecret,
          actor: input.creatorActor,
          authUserId: input.authUserId,
          packageId,
          channel: 'stable',
          artifactBaseUrl: input.vpmRepository.vpmBaseUrl,
          artifactBucketName: aliasArtifactStore.bucketName,
          artifactFormat: 'vpm-alias-zip-v1',
          contractVersion: 1,
          packageName,
          authorName:
            releasePresentation.packageMetadata?.author?.trim() ||
            creatorProfile?.name?.trim() ||
            'YUCP Club',
          description:
            releasePresentation.packageMetadata?.description?.trim() ||
            `Adds ${packageName} to this Unity project after purchase verification.`,
          ...(releasePresentation.packageMetadata?.tagline?.trim()
            ? { tagline: releasePresentation.packageMetadata.tagline.trim() }
            : {}),
          unityVersion: '2022.3',
          importerPackage: 'com.yucp.importer',
          minImporterVersion: '0.1.36',
          media: releasePresentation.bootstrapMedia ?? [],
        }
      );
      presentation = (await serviceConvex.query(
        api.vpmAliasPublications.getPresentationForService,
        {
          apiSecret: config.convexApiSecret,
          actor: serviceActor,
          packageId,
          channel: 'stable',
        }
      )) as VpmAliasPresentation | null;
    } else if (
      (input.packageNameOverride && presentation.packageName !== input.packageNameOverride) ||
      presentation.artifactBucketName !== aliasArtifactStore.bucketName ||
      presentation.artifactBaseUrl !== input.vpmRepository.vpmBaseUrl
    ) {
      await input.creatorConvex.mutation(api.vpmAliasPublications.updatePresentationForCreator, {
        apiSecret: config.convexApiSecret,
        actor: input.creatorActor,
        authUserId: input.authUserId,
        packageId,
        channel: presentation.channel,
        artifactBaseUrl: input.vpmRepository.vpmBaseUrl,
        artifactBucketName: aliasArtifactStore.bucketName,
        artifactFormat: 'vpm-alias-zip-v1',
        contractVersion: 1,
        packageName: input.packageNameOverride ?? presentation.packageName,
        authorName: presentation.authorName,
        description: presentation.description,
        ...(presentation.tagline ? { tagline: presentation.tagline } : {}),
        unityVersion: presentation.unityVersion,
        importerPackage: 'com.yucp.importer',
        minImporterVersion: presentation.minImporterVersion,
        media: presentation.media,
      });
      presentation = (await serviceConvex.query(
        api.vpmAliasPublications.getPresentationForService,
        {
          apiSecret: config.convexApiSecret,
          actor: serviceActor,
          packageId,
          channel: 'stable',
        }
      )) as VpmAliasPresentation | null;
    }
    if (!presentation) {
      throw new PublicAliasPublicationUnavailableError(
        'Package public bootstrap presentation was not persisted'
      );
    }
    const reservation = (await serviceConvex.mutation(
      api.vpmAliasPublications.reservePublicationForService,
      {
        apiSecret: config.convexApiSecret,
        actor: serviceActor,
        packageId,
        channel: 'stable',
        presentationFingerprintSha256: presentation.presentationFingerprintSha256,
        publicationId: crypto.randomUUID(),
        publicationReason: input.publicationReason ?? 'link-activation',
        ...(input.traceparent ? { traceparent: input.traceparent } : {}),
      }
    )) as VpmAliasPublicationReservation;
    if (reservation.status === 'PUBLISHED') {
      return;
    }

    try {
      const artifactUrl = `${input.vpmRepository.vpmBaseUrl}/api/vpm/alias-publications/${encodeURIComponent(
        reservation.publicationId
      )}/${encodeURIComponent(reservation.bootstrapVersion)}.zip`;
      const built = buildYucpAliasVpmPackage({
        aliasId: packageId,
        artifactUrl,
        bootstrapVersion: reservation.bootstrapVersion,
        vpmDependencies: {},
        packageMetadata: {
          packageName: presentation.packageName,
          author: presentation.authorName,
          description: presentation.description,
          ...(presentation.tagline ? { tagline: presentation.tagline } : {}),
        },
        ...(presentation.media.length > 0
          ? { media: await resolveBootstrapMedia(presentation.media) }
          : {}),
      });
      const artifact = await aliasArtifactStore.publish({
        body: built.bytes,
        bootstrapVersion: reservation.bootstrapVersion,
        packageId,
        publicationId: reservation.publicationId,
        sha256: built.zipSha256,
      });
      const repositoryManifestJson = JSON.stringify(built.manifest);
      await serviceConvex.mutation(api.vpmAliasPublications.commitPublicationForService, {
        apiSecret: config.convexApiSecret,
        actor: serviceActor,
        publicationId: reservation.publicationId,
        repositoryManifestJson,
        repositoryManifestSha256: createHash('sha256').update(repositoryManifestJson).digest('hex'),
        artifact,
      });
    } catch (error) {
      try {
        await serviceConvex.mutation(api.vpmAliasPublications.markPublicationFailedForService, {
          apiSecret: config.convexApiSecret,
          actor: serviceActor,
          publicationId: reservation.publicationId,
          failureCode: 'ARTIFACT_PUBLICATION_FAILED',
        });
      } catch (markError) {
        throw new AggregateError(
          [error, markError],
          'VPM alias publication failed and could not record its failure'
        );
      }
      throw new PublicAliasPublicationUnavailableError('VPM alias artifact publication failed', {
        cause: error,
      });
    }
  }

  function serializeCreatorLink(link: ActiveCreatorVpmLink, packageId: string, vpmBaseUrl: string) {
    const repository = buildPublicVpmRepositoryAccess(vpmBaseUrl, link.linkId);
    const bootstrapDownloadUrl = `/api/creator/packages/by-package/${encodeURIComponent(
      packageId
    )}/bootstrap`;
    return {
      status: 'active' as const,
      createdAt: link.createdAt,
      ...repository,
      bootstrapDownloadUrl,
    };
  }

  async function resolveCreatorVpmRepository(input: {
    actor: Awaited<ReturnType<typeof createAuthUserActorBinding>>;
    authUserId: string;
    convex: ReturnType<typeof getConvexClientFromUrl>;
    provisionDomain: boolean;
    vpmRepository: NonNullable<ReturnType<typeof getConfiguredVpmRepository>>;
  }): Promise<{
    creatorSlug: string;
    vpmRepository: NonNullable<ReturnType<typeof getConfiguredVpmRepository>>;
  }> {
    const profile = (await input.convex.query(api.creatorProfiles.getCreatorProfile, {
      apiSecret: config.convexApiSecret,
      authUserId: input.authUserId,
    })) as { name?: string; slug?: string; status?: string } | null;
    if (!profile || profile.status !== 'active') {
      throw new PrivateVpmDomainUnavailableError('Creator profile is unavailable');
    }
    const proposedSlugs = createPrivateVpmSlugCandidates(
      profile.name?.trim() || 'Creator',
      input.authUserId
    );
    if (profile.slug && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(profile.slug)) {
      proposedSlugs.unshift(profile.slug);
    }
    const namespace = (await input.convex.mutation(api.creatorProfiles.ensureDeliverySlug, {
      apiSecret: config.convexApiSecret,
      actor: input.actor,
      authUserId: input.authUserId,
      proposedSlugs: [...new Set(proposedSlugs)],
    })) as { created: boolean; slug: string };

    const privateRootDomain = getConfiguredPrivateVpmRootDomain(config);
    if (!privateRootDomain) {
      throw new PrivateVpmDomainUnavailableError('Private VPM delivery is not configured');
    }
    const privateVpmBaseUrl = buildPrivateVpmBaseUrl(privateRootDomain, namespace.slug);
    if (!privateVpmBaseUrl) {
      throw new PrivateVpmDomainUnavailableError('Creator private VPM hostname is invalid');
    }
    const hostname = new URL(privateVpmBaseUrl).hostname;
    if (input.provisionDomain) {
      if (!privateDomainProvisioner) {
        throw new PrivateVpmDomainUnavailableError(
          'Private VPM domain provisioning is not configured'
        );
      }
      try {
        const provisioned = await privateDomainProvisioner.ensureDomain(hostname);
        if (provisioned.hostname !== hostname || provisioned.status !== 'active') {
          throw new Error('Private VPM domain provisioner returned a mismatched domain');
        }
      } catch (error) {
        throw new PrivateVpmDomainUnavailableError(undefined, { cause: error });
      }
    }
    return {
      creatorSlug: namespace.slug,
      vpmRepository: {
        ...input.vpmRepository,
        vpmBaseUrl: privateVpmBaseUrl,
      },
    };
  }

  async function manageCreatorPresentation(request: Request, packageId: string): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'PUT') {
      return jsonNoStore({ error: 'Method not allowed' }, { status: 405 });
    }
    let phase = 'authentication';
    try {
      const authorized = await getCreatorPackageContext(request, packageId);
      if (authorized instanceof Response) {
        return authorized;
      }
      const vpmRepository = getConfiguredVpmRepository(config);
      if (!vpmRepository) {
        return jsonNoStore({ error: 'VPM delivery is not configured' }, { status: 503 });
      }
      phase = 'presentation';
      if (request.method === 'GET') {
        const actor = await createApiServiceActorBinding({
          authUserId: authorized.authUserId,
          service: 'creator-bootstrap-presentation',
          scopes: ['downloads:service'],
        });
        const convex = getConvexClientFromUrl(config.convexUrl, actor);
        const presentation = (await convex.query(
          api.vpmAliasPublications.getPresentationForService,
          {
            apiSecret: config.convexApiSecret,
            actor,
            packageId,
            channel: 'stable',
          }
        )) as VpmAliasPresentation | null;
        return jsonNoStore({
          packageName:
            presentation?.packageName ||
            authorized.product.packageName?.trim() ||
            authorized.product.displayName?.trim() ||
            authorized.product.aliasId?.trim() ||
            packageId,
          published: presentation !== null,
        });
      }
      if (!aliasArtifactStore) {
        return jsonNoStore({ error: 'VPM delivery is not configured' }, { status: 503 });
      }
      let body: Record<string, unknown>;
      try {
        body = await readJsonObjectBodyWithLimit(request, CREATOR_PRESENTATION_BODY_MAX_BYTES);
      } catch (error) {
        if (error instanceof RequestBodyError) {
          return jsonNoStore({ error: error.message }, { status: error.status });
        }
        throw error;
      }
      const packageName = typeof body.packageName === 'string' ? body.packageName.trim() : '';
      if (
        !packageName ||
        new TextEncoder().encode(packageName).byteLength > CREATOR_PACKAGE_NAME_MAX_BYTES ||
        Array.from(packageName).some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 31 || codePoint === 127;
        })
      ) {
        return jsonNoStore({ error: 'Package name is invalid' }, { status: 400 });
      }
      const candidateTraceparent = request.headers.get('traceparent');
      const traceparent =
        candidateTraceparent && parseTraceparent(candidateTraceparent)
          ? candidateTraceparent
          : undefined;
      phase = 'namespace';
      const creatorRepository = await resolveCreatorVpmRepository({
        actor: authorized.actor,
        authUserId: authorized.authUserId,
        convex: authorized.convex,
        provisionDomain: true,
        vpmRepository,
      });
      phase = 'publication';
      await ensurePackagePublication({
        authUserId: authorized.authUserId,
        creatorActor: authorized.actor,
        creatorConvex: authorized.convex,
        packageNameOverride: packageName,
        product: {
          ...authorized.product,
          packageName,
        },
        publicationReason: 'presentation-update',
        ...(traceparent ? { traceparent } : {}),
        vpmRepository: creatorRepository.vpmRepository,
      });
      return jsonNoStore({
        packageName,
        published: true,
      });
    } catch (error) {
      if (error instanceof PublicAliasPublicationUnavailableError) {
        return jsonNoStore({ error: 'VPM delivery is temporarily unavailable' }, { status: 503 });
      }
      logger.error('Creator bootstrap presentation operation failed', {
        phase,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return jsonNoStore({ error: 'Failed to manage bootstrap presentation' }, { status: 500 });
    }
  }

  async function manageCreatorLink(request: Request, packageId: string): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'DELETE') {
      return jsonNoStore({ error: 'Method not allowed' }, { status: 405 });
    }
    let phase = 'authentication';
    try {
      const authorized = await getCreatorPackageContext(request, packageId);
      if (authorized instanceof Response) {
        return authorized;
      }
      const vpmRepository = getConfiguredVpmRepository(config);
      if (!vpmRepository) {
        return jsonNoStore({ error: 'VPM delivery is not configured' }, { status: 503 });
      }
      if (request.method === 'DELETE') {
        phase = 'link';
        const result = await authorized.convex.mutation(api.creatorVpmLinks.revokeActive, {
          apiSecret: config.convexApiSecret,
          actor: authorized.actor,
          authUserId: authorized.authUserId,
          packageId: authorized.product.packageId as string,
        });
        return jsonNoStore(result);
      }

      if (request.method === 'POST') {
        phase = 'namespace';
        const creatorRepository = await resolveCreatorVpmRepository({
          actor: authorized.actor,
          authUserId: authorized.authUserId,
          convex: authorized.convex,
          provisionDomain: true,
          vpmRepository,
        });
        phase = 'publication';
        const candidateTraceparent = request.headers.get('traceparent');
        const traceparent =
          candidateTraceparent && parseTraceparent(candidateTraceparent)
            ? candidateTraceparent
            : undefined;
        await ensurePackagePublication({
          authUserId: authorized.authUserId,
          creatorActor: authorized.actor,
          creatorConvex: authorized.convex,
          product: authorized.product,
          ...(traceparent ? { traceparent } : {}),
          vpmRepository: creatorRepository.vpmRepository,
        });
        phase = 'link';
        const link = (await authorized.convex.mutation(api.creatorVpmLinks.ensureActive, {
          apiSecret: config.convexApiSecret,
          actor: authorized.actor,
          authUserId: authorized.authUserId,
          creatorSlug: creatorRepository.creatorSlug,
          packageId: authorized.product.packageId as string,
          proposedLinkId: createCreatorLinkId(),
        })) as ActiveCreatorVpmLink;
        return jsonNoStore(
          serializeCreatorLink(link, packageId, creatorRepository.vpmRepository.vpmBaseUrl)
        );
      }

      phase = 'link';
      const link = (await authorized.convex.query(api.creatorVpmLinks.getActiveForCreator, {
        apiSecret: config.convexApiSecret,
        actor: authorized.actor,
        authUserId: authorized.authUserId,
        packageId: authorized.product.packageId as string,
      })) as ActiveCreatorVpmLink | null;
      if (!link) {
        return jsonNoStore({
          status: 'inactive',
          bootstrapDownloadUrl: `/api/creator/packages/by-package/${encodeURIComponent(
            packageId
          )}/bootstrap`,
        });
      }
      const privateRootDomain = getConfiguredPrivateVpmRootDomain(config);
      const linkBaseUrl = buildPrivateVpmBaseUrl(privateRootDomain ?? undefined, link.creatorSlug);
      if (!linkBaseUrl) {
        throw new PrivateVpmDomainUnavailableError('Private VPM delivery is not configured');
      }
      return jsonNoStore(serializeCreatorLink(link, packageId, linkBaseUrl));
    } catch (error) {
      if (
        error instanceof PublicAliasPublicationUnavailableError ||
        error instanceof PrivateVpmDomainUnavailableError
      ) {
        return jsonNoStore({ error: 'VPM delivery is temporarily unavailable' }, { status: 503 });
      }
      logger.error('Creator VCC link operation failed', {
        phase,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return jsonNoStore({ error: 'Failed to manage the VCC link' }, { status: 500 });
    }
  }

  async function serveCreatorLinkIndex(request: Request, linkId: string): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonNoCache({ error: 'Method not allowed' }, { status: 405 });
    }
    if (!CREATOR_VPM_LINK_ID_PATTERN.test(linkId)) {
      return jsonNoCache({ error: 'VCC link is revoked or unavailable' }, { status: 410 });
    }
    const vpmRepository = getConfiguredVpmRepository(config);
    if (!vpmRepository || !aliasArtifactStore) {
      return jsonNoCache({ error: 'VPM delivery is not configured' }, { status: 503 });
    }
    let phase = 'actor';
    try {
      const actor = await createApiServiceActorBinding({
        service: 'vpm-repository',
        scopes: ['downloads:service'],
      });
      const convex = getConvexClientFromUrl(config.convexUrl, actor);
      phase = 'link';
      const link = (await convex.query(api.creatorVpmLinks.getActiveByLinkId, {
        apiSecret: config.convexApiSecret,
        actor,
        linkId,
      })) as ActiveCreatorVpmLink | null;
      if (!link) {
        return jsonNoCache({ error: 'VCC link is revoked or unavailable' }, { status: 410 });
      }
      const privateRootDomain = getConfiguredPrivateVpmRootDomain(config);
      const repositoryBaseUrl = buildPrivateVpmBaseUrl(
        privateRootDomain ?? undefined,
        link.creatorSlug
      );
      if (!repositoryBaseUrl) {
        throw new PrivateVpmDomainUnavailableError('Private VPM delivery is not configured');
      }
      const requestHostname = getPublicRequestHostname(request, config);
      const canonicalHostname = new URL(repositoryBaseUrl).hostname;
      if (requestHostname !== canonicalHostname) {
        const rootSuffix = privateRootDomain ? `.${privateRootDomain}` : '';
        const requestedCreatorSlug =
          rootSuffix &&
          requestHostname.endsWith(rootSuffix) &&
          !requestHostname.slice(0, -rootSuffix.length).includes('.')
            ? requestHostname.slice(0, -rootSuffix.length)
            : null;
        if (!requestedCreatorSlug) {
          return jsonNoCache({ error: 'VCC link is revoked or unavailable' }, { status: 410 });
        }
        phase = 'namespace';
        const namespace = (await convex.query(api.creatorProfiles.resolveDeliveryNamespace, {
          apiSecret: config.convexApiSecret,
          creatorSlug: requestedCreatorSlug,
        })) as { canonicalSlug: string; status: 'active' | 'alias' } | null;
        if (!namespace || namespace.canonicalSlug !== link.creatorSlug) {
          return jsonNoCache({ error: 'VCC link is revoked or unavailable' }, { status: 410 });
        }
      }
      phase = 'publications';
      const publications = (await convex.query(api.vpmAliasPublications.listPublishedForPackage, {
        apiSecret: config.convexApiSecret,
        actor,
        packageId: link.packageId,
        channel: 'stable',
        artifactBucketName: aliasArtifactStore.bucketName,
      })) as PublishedVpmAlias[];
      if (publications.length === 0) {
        return jsonNoCache({ error: 'VCC link is unavailable' }, { status: 410 });
      }
      phase = 'aliases';
      const packages = buildPublishedAliasPackages(publications);
      if (Object.keys(packages).length !== 1) {
        return jsonNoCache({ error: 'VCC link is unavailable' }, { status: 410 });
      }
      phase = 'importer';
      await mergePublicImporter(packages, vpmRepository);
      phase = 'response';
      const latest = publications.at(-1);
      const latestManifest = latest
        ? (JSON.parse(latest.repositoryManifestJson) as { displayName?: string })
        : undefined;
      const { indexUrl } = buildPublicVpmRepositoryAccess(repositoryBaseUrl, link.linkId);
      const response = jsonNoCache({
        name: latestManifest?.displayName
          ? `${latestManifest.displayName} by YUCP`
          : 'YUCP Product Bootstrap',
        author: 'YUCP',
        id: `club.yucp.creator-link.${link.packageId.replace(/[^a-z0-9._-]/g, '-')}`,
        url: indexUrl,
        packages,
      });
      return request.method === 'HEAD' ? new Response(null, response) : response;
    } catch (error) {
      if (error instanceof PublicImporterUnavailableError) {
        return jsonNoCache({ error: 'The public YUCP importer is not available' }, { status: 503 });
      }
      if (error instanceof PrivateVpmDomainUnavailableError) {
        return jsonNoCache({ error: 'VPM delivery is temporarily unavailable' }, { status: 503 });
      }
      logger.error('Failed to build creator VCC repository index', {
        phase,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return jsonNoCache({ error: 'Failed to build VCC repository' }, { status: 500 });
    }
  }

  async function downloadCreatorBootstrap(request: Request, packageId: string): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonNoStore({ error: 'Method not allowed' }, { status: 405 });
    }
    let phase = 'authentication';
    try {
      const authorized = await getCreatorPackageContext(request, packageId);
      if (authorized instanceof Response) {
        return authorized;
      }
      if (!aliasArtifactStore) {
        return jsonNoStore({ error: 'VPM delivery is not configured' }, { status: 503 });
      }
      phase = 'actor';
      const actor = await createApiServiceActorBinding({
        authUserId: authorized.authUserId,
        service: 'creator-bootstrap-download',
        scopes: ['downloads:service'],
      });
      const convex = getConvexClientFromUrl(config.convexUrl, actor);
      phase = 'publication';
      const publication = (await convex.query(
        api.vpmAliasPublications.getLatestPublishedForPackage,
        {
          apiSecret: config.convexApiSecret,
          actor,
          packageId: authorized.product.packageId as string,
          channel: 'stable',
          artifactBucketName: aliasArtifactStore.bucketName,
        }
      )) as PublishedVpmAlias | null;
      if (!publication) {
        return jsonNoStore({ error: 'Package has no published bootstrap' }, { status: 404 });
      }
      phase = 'artifact';
      const body = await aliasArtifactStore.readExact(publication.artifact);
      const filenameSeed =
        authorized.product.aliasId
          ?.trim()
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-') ||
        authorized.product.displayName
          ?.trim()
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-') ||
        'product';
      const headers = new Headers({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="${filenameSeed}-bootstrap-${publication.bootstrapVersion}.zip"`,
        'Content-Length': String(body.byteLength),
        'Content-Type': 'application/zip',
        ETag: `"${publication.artifact.sha256}"`,
      });
      return new Response(request.method === 'HEAD' ? null : Uint8Array.from(body).buffer, {
        status: 200,
        headers,
      });
    } catch (error) {
      logger.error('Creator bootstrap download failed', {
        phase,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return jsonNoStore({ error: 'Failed to read the published bootstrap' }, { status: 500 });
    }
  }

  async function serveAliasPublication(
    request: Request,
    publicationId: string,
    version: string
  ): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    if (!aliasArtifactStore || !getConfiguredVpmBaseUrl(config)) {
      return Response.json({ error: 'VPM delivery is not configured' }, { status: 503 });
    }
    try {
      const actor = await createApiServiceActorBinding({
        service: 'vpm-repository',
        scopes: ['downloads:service'],
      });
      const convex = getConvexClientFromUrl(config.convexUrl, actor);
      const publication = (await convex.query(
        api.vpmAliasPublications.getPublishedByPublicationId,
        {
          apiSecret: config.convexApiSecret,
          actor,
          publicationId,
        }
      )) as PublishedVpmAlias | null;
      if (!publication || publication.bootstrapVersion !== version) {
        return Response.json({ error: 'VPM alias package not found' }, { status: 404 });
      }
      const body = await aliasArtifactStore.readExact(publication.artifact);
      const headers = new Headers({
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Disposition': `attachment; filename="${publication.aliasPackageId}-${version}.zip"`,
        'Content-Length': String(body.byteLength),
        'Content-Type': 'application/zip',
        ETag: `"${publication.artifact.sha256}"`,
      });
      return new Response(request.method === 'HEAD' ? null : Uint8Array.from(body).buffer, {
        status: 200,
        headers,
      });
    } catch (error) {
      logger.error('Published VPM alias artifact read failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return Response.json(
        { error: 'VPM alias package is temporarily unavailable' },
        { status: 503 }
      );
    }
  }

  return {
    downloadCreatorBootstrap,
    manageCreatorLink,
    manageCreatorPresentation,
    serveAliasPublication,
    serveCreatorLinkIndex,
  };
}
