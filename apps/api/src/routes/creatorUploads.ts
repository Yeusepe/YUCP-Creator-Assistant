import { createHash } from 'node:crypto';
import { catalogTierPackageEditionId } from '@yucp/shared/packageEdition';
import { normalizeStrictSemanticVersion } from '@yucp/shared/semanticVersion';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { BILLING_CAPABILITY_KEYS } from '../../../../convex/lib/billingCapabilities';
import { ACTIVE_PROTECTION_POLICY_ID } from '../../../../ops/storage-core/protectionPolicyId';
import {
  signUploadCapability,
  UPLOAD_CAPABILITY_HEADERS,
} from '../../../../ops/storage-core/uploadSigning';
import type { Auth } from '../auth';
import { createAuthUserActorBinding } from '../lib/apiActor';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { RequestBodyError, readJsonObjectBodyWithLimit } from '../lib/requestBody';

export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const AUTHORIZE_BODY_MAX_BYTES = 4096;
const UPLOAD_VERSION_ID_PURPOSE = 'yucp-upload-version-v2';

export interface CreatorUploadConfig {
  apiBaseUrl: string;
  frontendBaseUrl: string;
  convexApiSecret: string;
  convexUrl: string;
  ingestTusUrl?: string;
  uploadHmacKey?: string;
}

interface CreateCreatorUploadRoutesOptions {
  auth: Auth;
  config: CreatorUploadConfig;
}

function allowedOrigins(config: CreatorUploadConfig): Set<string> {
  return new Set([new URL(config.apiBaseUrl).origin, new URL(config.frontendBaseUrl).origin]);
}

function requiredString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalCatalogProductIds(body: Record<string, unknown>): string[] | null | undefined {
  const value = body.catalogProductIds;
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    return null;
  }
  const ids = value.map((candidate) => (typeof candidate === 'string' ? candidate.trim() : ''));
  if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) {
    return null;
  }
  return ids;
}

function optionalCatalogTierId(body: Record<string, unknown>): string | null | undefined {
  const value = body.catalogTierId;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  return value.trim();
}

function addLengthPrefixedHashValue(hash: ReturnType<typeof createHash>, value: string): void {
  const body = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(body.byteLength);
  hash.update(length);
  hash.update(body);
}

export function deriveUploadVersionId(input: {
  creatorId: string;
  editionId?: string;
  packageId: string;
  version: string;
}): string {
  const hash = createHash('sha256');
  addLengthPrefixedHashValue(hash, UPLOAD_VERSION_ID_PURPOSE);
  addLengthPrefixedHashValue(hash, input.creatorId);
  addLengthPrefixedHashValue(hash, input.packageId);
  addLengthPrefixedHashValue(hash, input.editionId?.trim() || 'standard');
  addLengthPrefixedHashValue(hash, input.version);
  const bytes = hash.digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
}

export function createCreatorUploadRoutes({ auth, config }: CreateCreatorUploadRoutesOptions) {
  async function authorizeUpload(request: Request): Promise<Response> {
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

    let body: Record<string, unknown>;
    try {
      body = await readJsonObjectBodyWithLimit(request, AUTHORIZE_BODY_MAX_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const packageId = requiredString(body, 'packageId');
    const editionId = body.editionId === undefined ? 'standard' : requiredString(body, 'editionId');
    const version = requiredString(body, 'version');
    let catalogProductIds = optionalCatalogProductIds(body);
    const catalogTierId = optionalCatalogTierId(body);
    let catalogProductId: string | undefined;
    if (
      !packageId ||
      !editionId ||
      !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(editionId) ||
      !version ||
      catalogProductIds === null ||
      catalogTierId === null
    ) {
      return Response.json(
        {
          error:
            'packageId and version are required; catalog product and tier identifiers must be valid',
        },
        { status: 400 }
      );
    }
    try {
      normalizeStrictSemanticVersion(version, 'version');
    } catch {
      return Response.json({ error: 'version must be a valid Semantic Version' }, { status: 400 });
    }
    let expectedCatalogTierEditionId: string | undefined;
    if (catalogTierId) {
      try {
        expectedCatalogTierEditionId = catalogTierPackageEditionId(catalogTierId);
      } catch {
        return Response.json({ error: 'Catalog tier identifier is invalid' }, { status: 400 });
      }
      if (editionId !== expectedCatalogTierEditionId) {
        return Response.json(
          { error: 'Catalog tier does not match the package edition' },
          { status: 400 }
        );
      }
    }

    const actor = await createAuthUserActorBinding({
      authUserId: session.user.id,
      source: 'session',
    });
    const convex = getConvexClientFromUrl(config.convexUrl, actor);
    const registration = (await convex.query(api.packageRegistry.lookupRegistration, {
      apiSecret: config.convexApiSecret,
      actor,
      packageId,
    })) as { status: 'active' | 'archived'; yucpUserId: string } | null;
    if (registration?.status !== undefined && registration.status !== 'active') {
      return Response.json({ error: 'Active package ownership required' }, { status: 403 });
    }
    let creatorAuthUserId = registration?.yucpUserId;
    if (registration && registration.yucpUserId !== session.user.id) {
      const accessiblePackage = (await convex.query(api.packageRegistry.getByPackageIdForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor,
        authUserId: session.user.id,
        packageId,
      })) as { creatorAuthUserId: string; packageId?: string } | null;
      if (
        !accessiblePackage ||
        accessiblePackage.packageId !== packageId ||
        accessiblePackage.creatorAuthUserId !== registration.yucpUserId
      ) {
        return Response.json({ error: 'Active package ownership required' }, { status: 403 });
      }
    }
    if (!registration && !catalogProductIds) {
      return Response.json({ error: 'Catalog product ownership required' }, { status: 403 });
    }

    if (catalogProductIds) {
      const resolvedCatalogProductIds: string[] = [];
      for (const requestedCatalogProductId of catalogProductIds) {
        const product = (await convex.query(api.packageRegistry.getByIdForAuthUser, {
          apiSecret: config.convexApiSecret,
          actor,
          authUserId: session.user.id,
          catalogProductId: requestedCatalogProductId,
        })) as {
          _id?: string;
          catalogProductId?: string;
          creatorAuthUserId: string;
          packageId?: string;
        } | null;
        const resolvedCatalogProductId = product?._id ?? product?.catalogProductId;
        if (
          !product ||
          !resolvedCatalogProductId ||
          (creatorAuthUserId !== undefined && product.creatorAuthUserId !== creatorAuthUserId) ||
          (product.packageId !== undefined && product.packageId !== packageId)
        ) {
          return Response.json({ error: 'Catalog product ownership required' }, { status: 403 });
        }
        creatorAuthUserId = product.creatorAuthUserId;
        resolvedCatalogProductIds.push(resolvedCatalogProductId);
      }
      if (new Set(resolvedCatalogProductIds).size !== resolvedCatalogProductIds.length) {
        return Response.json({ error: 'Catalog product selection is ambiguous' }, { status: 409 });
      }
      catalogProductIds = resolvedCatalogProductIds;
      catalogProductId = catalogProductIds[0];
    }
    if (!creatorAuthUserId) {
      return Response.json({ error: 'Catalog product ownership required' }, { status: 403 });
    }

    const billing = (await convex.query(api.certificateBilling.getAccountOverview, {
      apiSecret: config.convexApiSecret,
      authUserId: creatorAuthUserId,
    })) as {
      billing?: { capabilities?: Array<{ capabilityKey: string; status: string }> };
    };
    const canUpload = billing.billing?.capabilities?.some(
      (capability) =>
        capability.capabilityKey === BILLING_CAPABILITY_KEYS.vpmRepo &&
        (capability.status === 'active' || capability.status === 'grace')
    );
    if (!canUpload) {
      return Response.json({ error: 'VPM repository capability required' }, { status: 403 });
    }

    let ensureCatalogTierEdition = false;
    if (editionId !== 'standard') {
      if (!catalogProductIds?.length) {
        return Response.json(
          { error: 'Catalog product required for this edition' },
          { status: 400 }
        );
      }
      const editions = (await convex.query(api.packageEditions.listForCreator, {
        apiSecret: config.convexApiSecret,
        actor,
        authUserId: creatorAuthUserId,
        packageId,
      })) as Array<{
        catalogProductIds: Array<Id<'product_catalog'>>;
        editionId: string;
        status: 'active' | 'archived';
      }>;
      const selectedEdition = editions.find(
        (edition) =>
          edition.editionId === editionId &&
          edition.status === 'active' &&
          edition.catalogProductIds.some((id) => catalogProductIds.includes(String(id)))
      );
      if (catalogTierId && editionId === expectedCatalogTierEditionId) {
        ensureCatalogTierEdition = true;
      } else if (!selectedEdition) {
        return Response.json({ error: 'Active package edition required' }, { status: 403 });
      }
    } else if (catalogTierId) {
      return Response.json(
        { error: 'The standard edition cannot target a catalog tier' },
        { status: 400 }
      );
    }

    const uploadHmacKey = config.uploadHmacKey?.trim();
    const ingestTusUrl = config.ingestTusUrl?.trim();
    if (!uploadHmacKey || !ingestTusUrl) {
      return Response.json({ error: 'Creator uploads are not configured' }, { status: 503 });
    }

    if (catalogProductIds?.length) {
      const claim = (await convex.mutation(api.packageRegistry.claimPackageForCreatorUpload, {
        apiSecret: config.convexApiSecret,
        actor,
        authUserId: creatorAuthUserId,
        catalogProductIds: catalogProductIds as Array<Id<'product_catalog'>>,
        packageId,
      })) as
        | { registered: true; conflict: false; archived: false }
        | { registered: false; conflict: true; archived: false }
        | { registered: false; conflict: false; archived: true; reason: string }
        | {
            registered: false;
            conflict: false;
            archived: false;
            catalogProductRejected: true;
          };

      if ('catalogProductRejected' in claim) {
        return Response.json({ error: 'Catalog product ownership required' }, { status: 403 });
      }
      if (claim.conflict) {
        return Response.json({ error: 'Package ID is already registered' }, { status: 409 });
      }
      if (claim.archived) {
        return Response.json({ error: claim.reason }, { status: 403 });
      }
    }
    if (editionId === 'standard' && catalogProductIds?.length) {
      await convex.mutation(api.packageEditions.ensureStandardForCreatorUpload, {
        apiSecret: config.convexApiSecret,
        actor,
        authUserId: creatorAuthUserId,
        catalogProductIds: catalogProductIds as Array<Id<'product_catalog'>>,
        packageId,
      });
    }
    if (ensureCatalogTierEdition && catalogProductIds?.length && catalogTierId) {
      const ensured = (await convex.mutation(
        api.packageEditions.ensureCatalogTierForCreatorUpload,
        {
          apiSecret: config.convexApiSecret,
          actor,
          authUserId: creatorAuthUserId,
          catalogProductIds: catalogProductIds as Array<Id<'product_catalog'>>,
          catalogTierId: catalogTierId as Id<'catalog_tiers'>,
          editionId,
          packageId,
        }
      )) as { catalogProductId?: Id<'product_catalog'> };
      if (ensured.catalogProductId) {
        catalogProductId = String(ensured.catalogProductId);
      }
    }

    const versionId = deriveUploadVersionId({
      creatorId: creatorAuthUserId,
      editionId,
      packageId,
      version,
    });
    const capability = await signUploadCapability({
      catalogProductId: catalogProductId ?? undefined,
      creatorId: creatorAuthUserId,
      editionId,
      versionId,
      key: uploadHmacKey,
      packageId,
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      version,
      expiresAt: Date.now() + UPLOAD_TTL_MS,
    });
    const headers = {
      ...(capability.catalogProductId
        ? {
            [UPLOAD_CAPABILITY_HEADERS.catalogProductId]: encodeURIComponent(
              capability.catalogProductId
            ),
          }
        : {}),
      [UPLOAD_CAPABILITY_HEADERS.versionId]: capability.versionId,
      [UPLOAD_CAPABILITY_HEADERS.exp]: capability.exp,
      [UPLOAD_CAPABILITY_HEADERS.creatorId]: encodeURIComponent(capability.creatorId),
      [UPLOAD_CAPABILITY_HEADERS.editionId]: capability.editionId,
      [UPLOAD_CAPABILITY_HEADERS.packageId]: encodeURIComponent(capability.packageId),
      [UPLOAD_CAPABILITY_HEADERS.protectionPolicyId]: capability.protectionPolicyId,
      [UPLOAD_CAPABILITY_HEADERS.sig]: capability.sig,
      [UPLOAD_CAPABILITY_HEADERS.version]: encodeURIComponent(capability.version),
    };

    return Response.json(
      {
        versionId,
        exp: capability.exp,
        sig: capability.sig,
        tusEndpoint: `${ingestTusUrl.replace(/\/+$/, '')}/files`,
        headers,
        editionId: capability.editionId,
        protectionPolicyId: capability.protectionPolicyId,
        ...(catalogProductId ? { catalogProductId } : {}),
      },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  return { authorizeUpload };
}
