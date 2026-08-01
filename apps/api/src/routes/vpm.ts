import { createHash } from 'node:crypto';
import {
  normalizeStrictSemanticVersion,
  parseTraceparent,
  timingSafeStringEqual,
  YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION,
  yucpBootstrapRequirementsPayload,
} from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { Auth } from '../auth';
import { createApiServiceActorBinding, createAuthUserActorBinding } from '../lib/apiActor';
import {
  type BootstrapIntentSigningConfig,
  signYucpBootstrapIntent,
} from '../lib/bootstrapIntentSigner';
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
  buildYucpBootstrapUnityPackage,
  loadYucpBootstrapUnityPackageRuntime,
} from './unityBootstrapPackage';
import {
  type BuiltYucpAliasVpmPackage,
  buildYucpAliasVpmPackage,
  normalizeYucpPackageVersion,
  type YucpAliasPackageMediaInput,
  type YucpAliasPackageMediaReference,
} from './vpmAliasPackage';
import {
  assertPublicImporterVersionsImmutable,
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
  privateVpmRootDomain?: string;
  vpmBaseUrl?: string;
}

interface CreateVpmRoutesOptions {
  aliasArtifactStore?: VpmAliasArtifactStore;
  auth: Auth;
  bootstrapIntentSigning?: BootstrapIntentSigningConfig;
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
    version: string;
  };
  editionId?: string;
  releaseRoot?: string;
  versionId?: string;
  vpmDependencies?: Record<string, string>;
  vpmRepositories?: Record<string, string>;
};

type BootstrapTarget = {
  bootstrapMedia?: YucpAliasPackageMediaReference[];
  editionId: string;
  packageMetadata?: PublicBootstrapPresentation['packageMetadata'];
  packageId: string;
  releaseRoot: string;
  state: 'READY' | 'SUPERSEDED';
  version: string;
  versionId: string;
  vpmDependencies?: Record<string, string>;
  vpmRepositories?: Record<string, string>;
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

function bootstrapMediaReferenceKey(entries: readonly YucpAliasPackageMediaReference[]): string {
  return JSON.stringify(
    entries.map((entry) => [
      entry.kind,
      entry.ordinal ?? 0,
      entry.sha256 ?? '',
      entry.label ?? '',
      entry.url ?? '',
      entry.localPath ?? '',
      entry.byteSize ?? 0,
      entry.contentType ?? '',
      entry.bucketName ?? '',
      entry.objectKey ?? '',
      entry.providerVersion ?? '',
    ])
  );
}

/**
 * The latest release is the source of truth for presentation values; the
 * stored presentation only fills gaps for releases without embedded metadata.
 */
function releaseDrivenPresentationValues(input: {
  packageName: string;
  presentation: VpmAliasPresentation | null;
  releasePresentation: PublicBootstrapPresentation;
}): {
  authorName?: string;
  description: string;
  media: YucpAliasPackageMediaReference[];
  tagline?: string;
} {
  const releaseMetadata = input.releasePresentation.packageMetadata;
  return {
    ...(releaseMetadata?.author?.trim() || input.presentation?.authorName
      ? { authorName: releaseMetadata?.author?.trim() || input.presentation?.authorName }
      : {}),
    description:
      releaseMetadata?.description?.trim() ||
      input.presentation?.description ||
      `Adds ${input.packageName} to this Unity project after purchase verification.`,
    media: input.releasePresentation.bootstrapMedia ?? [],
    ...(releaseMetadata?.tagline?.trim() ? { tagline: releaseMetadata.tagline.trim() } : {}),
  };
}

function presentationMatches(
  presentation: VpmAliasPresentation | null,
  desired: {
    artifactBaseUrl: string;
    artifactBucketName: string;
    authorName: string;
    description: string;
    media: readonly YucpAliasPackageMediaReference[];
    packageName: string;
    tagline?: string;
  }
): boolean {
  return (
    presentation !== null &&
    presentation.packageName === desired.packageName &&
    presentation.authorName === desired.authorName &&
    presentation.description === desired.description &&
    (presentation.tagline ?? undefined) === desired.tagline &&
    presentation.artifactBaseUrl === desired.artifactBaseUrl &&
    presentation.artifactBucketName === desired.artifactBucketName &&
    bootstrapMediaReferenceKey(presentation.media) === bootstrapMediaReferenceKey(desired.media)
  );
}

type VpmAliasPublicationReservation = {
  bootstrapVersion: string;
  channel: string;
  created: boolean;
  issuedAt: number;
  editionId?: string;
  packageId: string;
  packageVersion: string;
  releaseRoot?: string;
  presentationFingerprintSha256: string;
  publicationId: string;
  revision: number;
  status: 'PREPARING' | 'PUBLISHED';
  versionId?: string;
};

type PublishedVpmAlias = {
  aliasPackageId: string;
  artifact: VpmAliasArtifactReference;
  bootstrapVersion: string;
  channel: string;
  contractVersion: 1 | 2;
  createdAt: number;
  packageId: string;
  packageVersion?: string;
  editionId?: string;
  releaseRoot?: string;
  presentationFingerprintSha256: string;
  publicationId: string;
  publishedAt: number;
  repositoryManifestJson: string;
  repositoryManifestSha256: string;
  revision: number;
  status: 'PUBLISHED';
  versionId?: string;
};

type ActiveCreatorVpmLink = {
  createdAt: number;
  creatorSlug: string;
  linkId: string;
  packageId: string;
  status: 'active';
};

type ActiveBuyerCreatorVpmRepository = {
  createdAt: number;
  creatorName: string;
  creatorSlug: string;
  linkId: string;
  packages: Array<{
    editionId: string;
    packageId: string;
    releaseRoot: string;
    version: string;
    versionId: string;
  }>;
  packageIds: string[];
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
  bootstrapIntentSigning,
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
        references.map(async (reference) =>
          reference.objectKey === undefined
            ? { ...reference }
            : { ...reference, bytes: await bootstrapMediaReader.readExact(reference) }
        )
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
    for (const publication of [...publications].sort(
      (left, right) => left.revision - right.revision
    )) {
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
      const packageVersion =
        publication.packageVersion ?? normalizeYucpPackageVersion(String(manifest.version ?? ''));
      if (
        manifest.name !== publication.aliasPackageId ||
        publication.aliasPackageId !== publication.packageId ||
        manifest.version !== packageVersion ||
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
      const packageEntry = packages[publication.aliasPackageId] ?? { versions: {} };
      packageEntry.versions[packageVersion] = manifest as never;
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
      authUserId: product.creatorAuthUserId ?? session.user.id,
      convex,
      product,
    };
  }

  function bootstrapRequirementsDigest(
    vpmDependencies: Record<string, string> | undefined,
    vpmRepositories: Record<string, string> | undefined
  ): string {
    return createHash('sha256')
      .update(yucpBootstrapRequirementsPayload({ vpmDependencies, vpmRepositories }))
      .digest('hex');
  }

  async function publishReservedAlias(input: {
    artifactBaseUrl: string;
    packageId: string;
    presentation: VpmAliasPresentation;
    reservation: VpmAliasPublicationReservation;
    vpmDependencies?: Record<string, string>;
    vpmRepositories?: Record<string, string>;
    serviceActor: Awaited<ReturnType<typeof createApiServiceActorBinding>>;
    serviceConvex: ReturnType<typeof getConvexClientFromUrl>;
  }): Promise<void> {
    if (!aliasArtifactStore || input.reservation.status === 'PUBLISHED') {
      return;
    }
    try {
      const artifactUrl = `${input.artifactBaseUrl}/api/vpm/alias-publications/${encodeURIComponent(
        input.reservation.publicationId
      )}/${encodeURIComponent(input.reservation.bootstrapVersion)}.zip`;
      const bootstrapIntent =
        input.reservation.editionId && input.reservation.versionId && input.reservation.releaseRoot
          ? bootstrapIntentSigning
            ? await signYucpBootstrapIntent({
                aliasId: input.packageId,
                config: bootstrapIntentSigning,
                intent: {
                  schemaVersion: 1,
                  intentId: input.reservation.publicationId,
                  mode: 'specific',
                  issuedAt: input.reservation.issuedAt,
                  editionId: input.reservation.editionId,
                  version: input.reservation.packageVersion,
                  versionId: input.reservation.versionId,
                  releaseRoot: input.reservation.releaseRoot,
                  requirementsDigest: bootstrapRequirementsDigest(
                    input.vpmDependencies,
                    input.vpmRepositories
                  ),
                },
              })
            : undefined
          : undefined;
      if (
        input.reservation.editionId &&
        input.reservation.versionId &&
        input.reservation.releaseRoot &&
        !bootstrapIntent
      ) {
        throw new PublicAliasPublicationUnavailableError(
          'Bootstrap intent signing is not configured'
        );
      }
      const built = buildYucpAliasVpmPackage({
        aliasId: input.packageId,
        artifactUrl,
        bootstrapVersion: input.reservation.bootstrapVersion,
        ...(bootstrapIntent ? { bootstrapIntent } : {}),
        packageVersion: input.reservation.packageVersion,
        vpmDependencies: {},
        ...(input.vpmDependencies ? { releaseVpmDependencies: input.vpmDependencies } : {}),
        ...(input.vpmRepositories ? { releaseVpmRepositories: input.vpmRepositories } : {}),
        packageMetadata: {
          packageName: input.presentation.packageName,
          author: input.presentation.authorName,
          description: input.presentation.description,
          ...(input.presentation.tagline ? { tagline: input.presentation.tagline } : {}),
        },
        ...(input.presentation.media.length > 0
          ? { media: await resolveBootstrapMedia(input.presentation.media) }
          : {}),
      });
      const artifact = await aliasArtifactStore.publish({
        body: built.bytes,
        bootstrapVersion: input.reservation.bootstrapVersion,
        packageId: input.packageId,
        publicationId: input.reservation.publicationId,
        sha256: built.zipSha256,
      });
      const repositoryManifestJson = JSON.stringify(built.manifest);
      await input.serviceConvex.mutation(api.vpmAliasPublications.commitPublicationForService, {
        apiSecret: config.convexApiSecret,
        actor: input.serviceActor,
        publicationId: input.reservation.publicationId,
        repositoryManifestJson,
        repositoryManifestSha256: createHash('sha256').update(repositoryManifestJson).digest('hex'),
        artifact,
      });
    } catch (error) {
      try {
        await input.serviceConvex.mutation(
          api.vpmAliasPublications.markPublicationFailedForService,
          {
            apiSecret: config.convexApiSecret,
            actor: input.serviceActor,
            publicationId: input.reservation.publicationId,
            failureCode: 'ARTIFACT_PUBLICATION_FAILED',
          }
        );
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
    const releasePresentation = (await serviceConvex.query(
      api.packageVersions.resolvePublicBootstrapPresentation,
      {
        apiSecret: config.convexApiSecret,
        actor: serviceActor,
        packageId,
      }
    )) as PublicBootstrapPresentation | null;
    if (
      !releasePresentation?.packageMetadata?.version ||
      !releasePresentation.editionId ||
      !releasePresentation.versionId ||
      !releasePresentation.releaseRoot
    ) {
      throw new PublicAliasPublicationUnavailableError(
        'Package has no public bootstrap release version'
      );
    }
    let presentation = (await serviceConvex.query(
      api.vpmAliasPublications.getPresentationForService,
      {
        apiSecret: config.convexApiSecret,
        actor: serviceActor,
        packageId,
        channel: 'stable',
      }
    )) as VpmAliasPresentation | null;

    // The presentation mirrors the latest release: every publish re-derives its
    // values (name, author, description, tagline, media) instead of freezing
    // whatever was seeded first.
    const packageName =
      input.packageNameOverride ||
      releasePresentation.packageMetadata?.packageName?.trim() ||
      presentation?.packageName ||
      input.product.packageName?.trim() ||
      input.product.displayName?.trim() ||
      input.product.aliasId?.trim() ||
      packageId;
    const derived = releaseDrivenPresentationValues({
      packageName,
      presentation,
      releasePresentation,
    });
    let authorName = derived.authorName;
    if (!authorName) {
      const creatorProfile = (await serviceConvex.query(api.creatorProfiles.getCreatorProfile, {
        apiSecret: config.convexApiSecret,
        authUserId: input.authUserId,
      })) as { name?: string } | null;
      authorName = creatorProfile?.name?.trim() || 'YUCP Club';
    }
    const desired = {
      artifactBaseUrl: input.vpmRepository.vpmBaseUrl,
      artifactBucketName: aliasArtifactStore.bucketName,
      authorName,
      description: derived.description,
      media: derived.media,
      packageName,
      ...(derived.tagline ? { tagline: derived.tagline } : {}),
    };
    if (!presentationMatches(presentation, desired)) {
      const write = presentation
        ? api.vpmAliasPublications.updatePresentationForCreator
        : api.vpmAliasPublications.seedPresentationIfMissingForCreator;
      await input.creatorConvex.mutation(write, {
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
        authorName,
        description: desired.description,
        ...(desired.tagline ? { tagline: desired.tagline } : {}),
        unityVersion: presentation?.unityVersion ?? '2022.3',
        importerPackage: 'com.yucp.importer',
        minImporterVersion:
          presentation?.minImporterVersion ?? YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION,
        media: desired.media,
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
        packageVersion: releasePresentation.packageMetadata.version,
        editionId: releasePresentation.editionId,
        versionId: releasePresentation.versionId,
        releaseRoot: releasePresentation.releaseRoot,
        publicationReason: input.publicationReason ?? 'link-activation',
        ...(input.traceparent ? { traceparent: input.traceparent } : {}),
      }
    )) as VpmAliasPublicationReservation;
    await publishReservedAlias({
      artifactBaseUrl: input.vpmRepository.vpmBaseUrl,
      packageId,
      presentation,
      reservation,
      serviceActor,
      serviceConvex,
      ...(releasePresentation.vpmDependencies
        ? { vpmDependencies: releasePresentation.vpmDependencies }
        : {}),
      ...(releasePresentation.vpmRepositories
        ? { vpmRepositories: releasePresentation.vpmRepositories }
        : {}),
    });
  }

  type ServiceReleasePublicationInput = {
    artifactBaseUrl: string;
    editionId: string;
    packageId: string;
    packageVersion: string;
    releasePresentation?: PublicBootstrapPresentation;
    releaseRoot: string;
    serviceActor: Awaited<ReturnType<typeof createApiServiceActorBinding>>;
    serviceConvex: ReturnType<typeof getConvexClientFromUrl>;
    versionId: string;
  };

  async function syncServicePresentationForRelease(
    input: ServiceReleasePublicationInput
  ): Promise<VpmAliasPresentation> {
    if (!aliasArtifactStore) {
      throw new PublicAliasPublicationUnavailableError();
    }
    let presentation = (await input.serviceConvex.query(
      api.vpmAliasPublications.getPresentationForService,
      {
        apiSecret: config.convexApiSecret,
        actor: input.serviceActor,
        packageId: input.packageId,
        channel: 'stable',
      }
    )) as VpmAliasPresentation | null;
    // Publications triggered without a creator session must still serve the
    // latest release values, so sync the presentation before publishing.
    const releasePresentation =
      input.releasePresentation ??
      ((await input.serviceConvex.query(api.packageVersions.resolveBootstrapTargetForService, {
        apiSecret: config.convexApiSecret,
        actor: input.serviceActor,
        packageId: input.packageId,
        editionId: input.editionId,
        versionId: input.versionId,
      })) as BootstrapTarget | null);
    if (releasePresentation?.packageMetadata?.version) {
      const packageName =
        releasePresentation.packageMetadata?.packageName?.trim() ||
        presentation?.packageName ||
        input.packageId;
      const derived = releaseDrivenPresentationValues({
        packageName,
        presentation,
        releasePresentation,
      });
      const desired = {
        artifactBaseUrl: input.artifactBaseUrl,
        artifactBucketName: aliasArtifactStore.bucketName,
        authorName: derived.authorName ?? 'YUCP Club',
        description: derived.description,
        media: derived.media,
        packageName,
        ...(derived.tagline ? { tagline: derived.tagline } : {}),
      };
      if (!presentationMatches(presentation, desired)) {
        await input.serviceConvex.mutation(api.vpmAliasPublications.syncPresentationForService, {
          apiSecret: config.convexApiSecret,
          actor: input.serviceActor,
          packageId: input.packageId,
          channel: 'stable',
          artifactBaseUrl: desired.artifactBaseUrl,
          artifactBucketName: desired.artifactBucketName,
          artifactFormat: 'vpm-alias-zip-v1',
          contractVersion: 1,
          packageName: desired.packageName,
          authorName: desired.authorName,
          description: desired.description,
          ...(desired.tagline ? { tagline: desired.tagline } : {}),
          unityVersion: presentation?.unityVersion ?? '2022.3',
          importerPackage: 'com.yucp.importer',
          minImporterVersion:
            presentation?.minImporterVersion ?? YUCP_ALIAS_PACKAGE_DEFAULT_IMPORTER_MIN_VERSION,
          media: desired.media,
        });
        presentation = (await input.serviceConvex.query(
          api.vpmAliasPublications.getPresentationForService,
          {
            apiSecret: config.convexApiSecret,
            actor: input.serviceActor,
            packageId: input.packageId,
            channel: 'stable',
          }
        )) as VpmAliasPresentation | null;
      }
    }
    if (!presentation) {
      throw new PublicAliasPublicationUnavailableError(
        'Package public bootstrap presentation is unavailable'
      );
    }
    return presentation;
  }

  async function ensureServicePublicationForRelease(
    input: ServiceReleasePublicationInput
  ): Promise<void> {
    if (!aliasArtifactStore) {
      throw new PublicAliasPublicationUnavailableError();
    }
    const presentation = await syncServicePresentationForRelease(input);
    const releaseTarget =
      input.releasePresentation ??
      ((await input.serviceConvex.query(api.packageVersions.resolveBootstrapTargetForService, {
        apiSecret: config.convexApiSecret,
        actor: input.serviceActor,
        packageId: input.packageId,
        editionId: input.editionId,
        versionId: input.versionId,
      })) as BootstrapTarget | null);
    const reservation = (await input.serviceConvex.mutation(
      api.vpmAliasPublications.reservePublicationForService,
      {
        apiSecret: config.convexApiSecret,
        actor: input.serviceActor,
        packageId: input.packageId,
        channel: 'stable',
        presentationFingerprintSha256: presentation.presentationFingerprintSha256,
        publicationId: crypto.randomUUID(),
        packageVersion: input.packageVersion,
        editionId: input.editionId,
        versionId: input.versionId,
        releaseRoot: input.releaseRoot,
        publicationReason: 'link-activation',
      }
    )) as VpmAliasPublicationReservation;
    await publishReservedAlias({
      artifactBaseUrl: input.artifactBaseUrl,
      packageId: input.packageId,
      presentation,
      reservation,
      serviceActor: input.serviceActor,
      serviceConvex: input.serviceConvex,
      ...(releaseTarget?.vpmDependencies ? { vpmDependencies: releaseTarget.vpmDependencies } : {}),
      ...(releaseTarget?.vpmRepositories ? { vpmRepositories: releaseTarget.vpmRepositories } : {}),
    });
  }

  function serializeCreatorDeliveryStatus(link: ActiveCreatorVpmLink, packageId: string) {
    const downloadBase = `/api/creator/packages/by-package/${encodeURIComponent(packageId)}`;
    return {
      status: 'active' as const,
      createdAt: link.createdAt,
      bootstrapDownloadUrl: `${downloadBase}/bootstrap`,
      unityPackageDownloadUrl: `${downloadBase}/bootstrap.unitypackage`,
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
        return jsonNoStore(serializeCreatorDeliveryStatus(link, packageId));
      }

      phase = 'link';
      const link = (await authorized.convex.query(api.creatorVpmLinks.getActiveForCreator, {
        apiSecret: config.convexApiSecret,
        actor: authorized.actor,
        authUserId: authorized.authUserId,
        packageId: authorized.product.packageId as string,
      })) as ActiveCreatorVpmLink | null;
      if (!link) {
        const downloadBase = `/api/creator/packages/by-package/${encodeURIComponent(packageId)}`;
        return jsonNoStore({
          status: 'inactive',
          bootstrapDownloadUrl: `${downloadBase}/bootstrap`,
          unityPackageDownloadUrl: `${downloadBase}/bootstrap.unitypackage`,
        });
      }
      return jsonNoStore(serializeCreatorDeliveryStatus(link, packageId));
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
      const link = (await convex.query(api.buyerCreatorVpmRepositories.getActiveByLinkId, {
        apiSecret: config.convexApiSecret,
        actor,
        linkId,
      })) as ActiveBuyerCreatorVpmRepository | null;
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
      const publications: PublishedVpmAlias[] = [];
      for (const entitledPackage of link.packages) {
        const packageVersion = normalizeYucpPackageVersion(entitledPackage.version);
        const eligibleTargets = (await convex.query(
          api.packageVersions.listBootstrapTargetsForService,
          {
            apiSecret: config.convexApiSecret,
            actor,
            packageId: entitledPackage.packageId,
            editionId: entitledPackage.editionId,
          }
        )) as BootstrapTarget[];
        const currentTarget = eligibleTargets.find(
          (target) =>
            target.version === packageVersion &&
            target.versionId === entitledPackage.versionId &&
            target.releaseRoot === entitledPackage.releaseRoot
        );
        if (!currentTarget) {
          throw new PublicAliasPublicationUnavailableError(
            'Current package release is not eligible for VCC publication'
          );
        }
        const targetIdentity = (target: {
          editionId?: string;
          releaseRoot?: string;
          versionId?: string;
        }) => `${target.editionId}\n${target.versionId}\n${target.releaseRoot}`;
        const eligibleTargetIds = new Set(eligibleTargets.map(targetIdentity));
        const loadPublications = async () =>
          (await convex.query(api.vpmAliasPublications.listPublishedForPackage, {
            apiSecret: config.convexApiSecret,
            actor,
            packageId: entitledPackage.packageId,
            channel: 'stable',
            artifactBucketName: aliasArtifactStore.bucketName,
          })) as PublishedVpmAlias[];
        let packagePublications = await loadPublications();
        let presentationNeedsCurrentRestore = false;
        for (const target of eligibleTargets) {
          if (
            targetIdentity(target) === targetIdentity(currentTarget) ||
            packagePublications.some(
              (publication) =>
                publication.aliasPackageId === entitledPackage.packageId &&
                publication.contractVersion === 2 &&
                publication.packageVersion === target.version &&
                targetIdentity(publication) === targetIdentity(target)
            )
          ) {
            continue;
          }
          phase = 'publication-refresh';
          await ensureServicePublicationForRelease({
            artifactBaseUrl: repositoryBaseUrl,
            editionId: target.editionId,
            packageId: entitledPackage.packageId,
            packageVersion: target.version,
            releasePresentation: target,
            releaseRoot: target.releaseRoot,
            serviceActor: actor,
            serviceConvex: convex,
            versionId: target.versionId,
          });
          presentationNeedsCurrentRestore = true;
          packagePublications = await loadPublications();
        }
        phase = 'publication-refresh';
        const currentPublicationExists = packagePublications.some(
          (publication) =>
            publication.aliasPackageId === entitledPackage.packageId &&
            publication.contractVersion === 2 &&
            publication.packageVersion === currentTarget.version &&
            targetIdentity(publication) === targetIdentity(currentTarget)
        );
        const currentPublicationInput = {
          artifactBaseUrl: repositoryBaseUrl,
          editionId: currentTarget.editionId,
          packageId: entitledPackage.packageId,
          packageVersion: currentTarget.version,
          releasePresentation: currentTarget,
          releaseRoot: currentTarget.releaseRoot,
          serviceActor: actor,
          serviceConvex: convex,
          versionId: currentTarget.versionId,
        };
        if (!currentPublicationExists) {
          await ensureServicePublicationForRelease(currentPublicationInput);
          packagePublications = await loadPublications();
        } else if (presentationNeedsCurrentRestore) {
          await syncServicePresentationForRelease(currentPublicationInput);
        }
        const validPublications = packagePublications.filter((publication) => {
          if (
            publication.aliasPackageId !== entitledPackage.packageId ||
            publication.contractVersion !== 2 ||
            typeof publication.packageVersion !== 'string' ||
            !eligibleTargetIds.has(targetIdentity(publication))
          ) {
            return false;
          }
          try {
            return (
              normalizeStrictSemanticVersion(publication.packageVersion, 'VPM package version') ===
              publication.packageVersion
            );
          } catch {
            return false;
          }
        });
        if (validPublications.length !== eligibleTargets.length) {
          throw new PublicAliasPublicationUnavailableError(
            'One or more retained package releases have no VPM publication'
          );
        }
        publications.push(...validPublications);
      }
      if (publications.length === 0) {
        return jsonNoCache({ error: 'VCC link is unavailable' }, { status: 410 });
      }
      phase = 'aliases';
      const packages = buildPublishedAliasPackages(publications);
      phase = 'importer';
      await mergePublicImporter(packages, vpmRepository);
      phase = 'response';
      const { indexUrl } = buildPublicVpmRepositoryAccess(repositoryBaseUrl, link.linkId);
      const response = jsonNoCache({
        name: `${link.creatorName} verified packages`,
        author: 'YUCP',
        id: `club.yucp.creator.${link.creatorSlug}.verified`,
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
      if (error instanceof PublicAliasPublicationUnavailableError) {
        return jsonNoCache({ error: 'VPM delivery is temporarily unavailable' }, { status: 503 });
      }
      logger.error('Failed to build creator VCC repository index', {
        phase,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return jsonNoCache({ error: 'Failed to build VCC repository' }, { status: 500 });
    }
  }

  type CreatorBootstrapSelection =
    | { mode: 'latest'; editionId: string }
    | { mode: 'specific'; editionId: string; versionId: string };

  function parseCreatorBootstrapSelection(request: Request): CreatorBootstrapSelection {
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode')?.trim() || 'latest';
    const editionId = url.searchParams.get('editionId')?.trim() || 'standard';
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(editionId)) {
      throw new RequestBodyError('Package edition is invalid', 400);
    }
    if (mode === 'latest') {
      if (url.searchParams.has('versionId')) {
        throw new RequestBodyError('Latest bootstrap must not specify a version', 400);
      }
      return { mode, editionId };
    }
    const versionId = url.searchParams.get('versionId')?.trim();
    if (
      mode !== 'specific' ||
      !versionId ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(versionId)
    ) {
      throw new RequestBodyError('Specific bootstrap version is invalid', 400);
    }
    return { mode, editionId, versionId };
  }

  async function buildCreatorBootstrap(input: {
    authUserId: string;
    product: CreatorVpmProduct;
    selection: CreatorBootstrapSelection;
  }): Promise<{
    bootstrap: BuiltYucpAliasVpmPackage;
    publication: PublishedVpmAlias;
    target: BootstrapTarget;
  } | null> {
    if (!aliasArtifactStore || !input.product.packageId || !bootstrapIntentSigning) {
      throw new PublicAliasPublicationUnavailableError();
    }
    const actor = await createApiServiceActorBinding({
      authUserId: input.authUserId,
      service: 'creator-bootstrap-download',
      scopes: ['downloads:service'],
    });
    const convex = getConvexClientFromUrl(config.convexUrl, actor);
    const target = (await convex.query(api.packageVersions.resolveBootstrapTargetForService, {
      apiSecret: config.convexApiSecret,
      actor,
      packageId: input.product.packageId,
      editionId: input.selection.editionId,
      ...(input.selection.mode === 'specific' ? { versionId: input.selection.versionId } : {}),
    })) as BootstrapTarget | null;
    if (!target) {
      return null;
    }
    const readPublications = async () =>
      (await convex.query(api.vpmAliasPublications.listPublishedForPackage, {
        apiSecret: config.convexApiSecret,
        actor,
        packageId: input.product.packageId as string,
        channel: 'stable',
        artifactBucketName: aliasArtifactStore.bucketName,
      })) as PublishedVpmAlias[];
    const readPresentation = async () =>
      (await convex.query(api.vpmAliasPublications.getPresentationForService, {
        apiSecret: config.convexApiSecret,
        actor,
        packageId: input.product.packageId as string,
        channel: 'stable',
      })) as VpmAliasPresentation | null;
    let publications = await readPublications();
    let publication = publications.find(
      (candidate) =>
        candidate.contractVersion === 2 &&
        candidate.packageVersion === target.version &&
        candidate.editionId === target.editionId &&
        candidate.versionId === target.versionId &&
        candidate.releaseRoot === target.releaseRoot
    );
    let presentation = await readPresentation();
    if (!publication) {
      const repository = getConfiguredVpmRepository(config);
      if (!repository) {
        throw new PublicAliasPublicationUnavailableError();
      }
      await ensureServicePublicationForRelease({
        artifactBaseUrl: repository.vpmBaseUrl,
        editionId: target.editionId,
        packageId: target.packageId,
        packageVersion: target.version,
        releasePresentation: {
          bootstrapMedia: target.bootstrapMedia,
          editionId: target.editionId,
          packageMetadata: target.packageMetadata ?? { version: target.version },
          releaseRoot: target.releaseRoot,
          versionId: target.versionId,
        },
        releaseRoot: target.releaseRoot,
        serviceActor: actor,
        serviceConvex: convex,
        versionId: target.versionId,
      });
      publications = await readPublications();
      publication = publications.find(
        (candidate) =>
          candidate.contractVersion === 2 &&
          candidate.packageVersion === target.version &&
          candidate.editionId === target.editionId &&
          candidate.versionId === target.versionId &&
          candidate.releaseRoot === target.releaseRoot
      );
      presentation = await readPresentation();
      if (!publication) {
        return null;
      }
    }
    const publishedPackages = buildPublishedAliasPackages([publication]);
    const publishedVersions = publishedPackages[publication.aliasPackageId]?.versions;
    const publishedPackageVersion =
      publication.packageVersion ?? Object.keys(publishedVersions ?? {})[0];
    const publishedManifest = publishedPackageVersion
      ? publishedVersions?.[publishedPackageVersion]
      : undefined;
    if (
      !publishedPackageVersion ||
      !publishedManifest ||
      typeof publishedManifest.url !== 'string'
    ) {
      throw new PublicAliasPublicationUnavailableError(
        'Published bootstrap manifest is unavailable'
      );
    }
    const releaseMetadata = target.packageMetadata;
    const packageName =
      releaseMetadata?.packageName?.trim() ||
      presentation?.packageName ||
      input.product.packageName?.trim() ||
      input.product.displayName?.trim() ||
      input.product.aliasId?.trim() ||
      input.product.packageId;
    const mediaReferences = target.bootstrapMedia ?? presentation?.media ?? [];
    const bootstrapIntent = await signYucpBootstrapIntent({
      aliasId: input.product.packageId,
      config: bootstrapIntentSigning,
      intent: {
        schemaVersion: 1,
        intentId: crypto.randomUUID(),
        mode: input.selection.mode,
        issuedAt: Math.floor(Date.now() / 1_000),
        editionId: target.editionId,
        ...(input.selection.mode === 'specific'
          ? {
              version: target.version,
              versionId: target.versionId,
              releaseRoot: target.releaseRoot,
            }
          : {}),
        requirementsDigest: bootstrapRequirementsDigest(
          target.vpmDependencies,
          target.vpmRepositories
        ),
      },
    });
    const bootstrap = buildYucpAliasVpmPackage({
      aliasId: input.product.packageId,
      artifactUrl: publishedManifest.url,
      bootstrapVersion: publication.bootstrapVersion,
      bootstrapIntent,
      packageVersion: target.version,
      // The bootstrap stays a stable pointer: it pulls in the importer and
      // nothing else. The importer asks the broker what the release it is
      // actually fetching needs, so an update that changes requirements does
      // not leave every bootstrap already downloaded describing the old set.
      vpmDependencies: {},
      // Shown on the import screen so the buyer sees what the release pulls in
      // before consenting. requirementsDigest covers exactly these maps.
      ...(target.vpmDependencies ? { releaseVpmDependencies: target.vpmDependencies } : {}),
      ...(target.vpmRepositories ? { releaseVpmRepositories: target.vpmRepositories } : {}),
      packageMetadata: {
        packageName,
        author: releaseMetadata?.author?.trim() || presentation?.authorName || 'YUCP Club',
        description:
          releaseMetadata?.description?.trim() ||
          presentation?.description ||
          `Adds ${packageName} to this Unity project after purchase verification.`,
        ...(releaseMetadata?.tagline?.trim() || presentation?.tagline
          ? { tagline: releaseMetadata?.tagline?.trim() || presentation?.tagline }
          : {}),
      },
      ...(mediaReferences.length > 0
        ? { media: await resolveBootstrapMedia(mediaReferences) }
        : {}),
    });
    return { bootstrap, publication, target };
  }

  function creatorBootstrapFilenameSeed(product: CreatorVpmProduct): string {
    return (
      product.aliasId
        ?.trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-') ||
      product.displayName
        ?.trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-') ||
      'product'
    );
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
      const selection = parseCreatorBootstrapSelection(request);
      phase = 'bootstrap';
      const current = await buildCreatorBootstrap({
        authUserId: authorized.authUserId,
        product: authorized.product,
        selection,
      });
      if (!current) {
        return jsonNoStore({ error: 'Package has no published bootstrap' }, { status: 404 });
      }
      const body = current.bootstrap.bytes;
      const filenameSeed = creatorBootstrapFilenameSeed(authorized.product);
      const headers = new Headers({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="${filenameSeed}-bootstrap-${selection.mode === 'latest' ? 'latest' : current.target.version}.zip"`,
        'Content-Length': String(body.byteLength),
        'Content-Type': 'application/zip',
        ETag: `"${current.bootstrap.zipSha256}"`,
      });
      return new Response(request.method === 'HEAD' ? null : Uint8Array.from(body).buffer, {
        status: 200,
        headers,
      });
    } catch (error) {
      logger.error('Creator bootstrap download failed', {
        phase,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof PublicAliasPublicationUnavailableError) {
        return jsonNoStore({ error: 'VPM delivery is temporarily unavailable' }, { status: 503 });
      }
      if (error instanceof RequestBodyError) {
        return jsonNoStore({ error: error.message }, { status: error.status });
      }
      return jsonNoStore({ error: 'Failed to read the published bootstrap' }, { status: 500 });
    }
  }

  async function downloadCreatorUnityPackage(
    request: Request,
    packageId: string
  ): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonNoStore({ error: 'Method not allowed' }, { status: 405 });
    }
    let phase = 'authentication';
    try {
      const authorized = await getCreatorPackageContext(request, packageId);
      if (authorized instanceof Response) {
        return authorized;
      }
      if (!aliasArtifactStore || !config.publicVpmIndexUrl?.trim()) {
        return jsonNoStore({ error: 'VPM delivery is not configured' }, { status: 503 });
      }
      const selection = parseCreatorBootstrapSelection(request);
      phase = 'bootstrap';
      const current = await buildCreatorBootstrap({
        authUserId: authorized.authUserId,
        product: authorized.product,
        selection,
      });
      if (!current) {
        return jsonNoStore({ error: 'Package has no published bootstrap' }, { status: 404 });
      }
      phase = 'unity-package';
      const runtime = await loadYucpBootstrapUnityPackageRuntime();
      const unityPackage = buildYucpBootstrapUnityPackage({
        bootstrap: current.bootstrap,
        importerRepositoryUrl: config.publicVpmIndexUrl,
        ...runtime,
      });
      const filenameSeed = creatorBootstrapFilenameSeed(authorized.product);
      const headers = new Headers({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="${filenameSeed}-bootstrap-${selection.mode === 'latest' ? 'latest' : current.target.version}.unitypackage"`,
        'Content-Length': String(unityPackage.bytes.byteLength),
        'Content-Type': 'application/gzip',
        ETag: `"${unityPackage.sha256}"`,
      });
      return new Response(
        request.method === 'HEAD' ? null : Uint8Array.from(unityPackage.bytes).buffer,
        {
          status: 200,
          headers,
        }
      );
    } catch (error) {
      logger.error('Creator Unity package download failed', {
        phase,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof PublicAliasPublicationUnavailableError) {
        return jsonNoStore({ error: 'VPM delivery is temporarily unavailable' }, { status: 503 });
      }
      if (error instanceof RequestBodyError) {
        return jsonNoStore({ error: error.message }, { status: error.status });
      }
      return jsonNoStore({ error: 'Failed to build the Unity bootstrap package' }, { status: 500 });
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
    downloadCreatorUnityPackage,
    manageCreatorLink,
    manageCreatorPresentation,
    serveAliasPublication,
    serveCreatorLinkIndex,
  };
}
