import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type {
  PackageInstallAccessPort,
  PackageInstallProductGroup,
} from '../routes/packageInstallSessions';
import { createApiServiceActorBinding } from './apiActor';
import { getConvexClientFromUrl } from './convex';

export interface PackageInstallAccessConfig {
  convexApiSecret: string;
  convexUrl: string;
  publicationAuthority: PackageInstallPublicationAuthority;
}

export interface PackageInstallPublicationAuthority {
  resolveInstalledVersion(input: {
    editionId: string;
    packageId: string;
    releaseRoot: string;
  }): Promise<AuthoritativePackageVersion | null>;
  resolveReadyVersion(input: {
    editionId: string;
    packageId: string;
    releaseRoot: string;
  }): Promise<AuthoritativePackageVersion | null>;
}

export interface AuthoritativePackageVersion {
  activeContentDigest: string | null;
  activePolicyVersion: string | null;
  bindingRoot: string | null;
  commonRoot: string | null;
  id: string;
  logicalBytes: number | null;
  logicalFiles: number | null;
  manifestSha256: string | null;
  protectedFiles: unknown;
  protectedSourceRoot: string | null;
  protectionPolicyDigest: string | null;
  protectionPolicyId: string | null;
  releaseRoot: string | null;
  version: string;
}

type BuyerAccessContext = {
  aliasId: string;
  catalogProductIds: Id<'product_catalog'>[];
  creatorAuthUserId: string;
  packageId?: string;
  storefronts: Array<{
    catalogProductId: Id<'product_catalog'>;
    productId: string;
  }>;
};

type PublishedVersion = {
  activeContentDigest?: string;
  activePolicyVersion?: string;
  bindingRoot?: string;
  commonRoot?: string;
  logicalBytes?: number;
  logicalFiles?: number;
  manifestSha256?: string;
  packageId: string;
  protectedFiles?: Array<{
    materializerType: string;
    normalizedPath: string;
    required: boolean;
    sourceSha256: string;
  }>;
  protectedSourceRoot?: string;
  protectionPolicyDigest?: string;
  protectionPolicyId?: string;
  releaseRoot?: string;
  version: string;
  versionId: string;
};

function normalizeGroup(context: BuyerAccessContext): PackageInstallProductGroup | null {
  if (!context.packageId) {
    return null;
  }
  return {
    aliasId: context.aliasId,
    catalogProductIds: context.catalogProductIds.map(String),
    creatorId: context.creatorAuthUserId,
    packageId: context.packageId,
    storefronts: context.storefronts.map((storefront) => ({
      catalogProductId: String(storefront.catalogProductId),
      productId: storefront.productId,
    })),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((entry) => JSON.parse(canonicalJson(entry)) as unknown));
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, JSON.parse(canonicalJson(entry)) as unknown])
      )
    );
  }
  return JSON.stringify(value);
}

/**
 * Convex mirrors only these four fields (ops/catalog/convexPublish.ts); the catalog
 * additionally stamps coupling routing metadata that never leaves the authority.
 */
function publicProtectedFilesProjection(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return entry;
    }
    const file = entry as Record<string, unknown>;
    return {
      materializerType: file.materializerType,
      normalizedPath: file.normalizedPath,
      required: file.required,
      sourceSha256: file.sourceSha256,
    };
  });
}

function publicationMatchesAuthority(
  published: PublishedVersion,
  authoritative: AuthoritativePackageVersion
): boolean {
  return (
    authoritative.activeContentDigest === published.activeContentDigest &&
    authoritative.activePolicyVersion === published.activePolicyVersion &&
    authoritative.bindingRoot === published.bindingRoot &&
    authoritative.commonRoot === published.commonRoot &&
    authoritative.logicalBytes === published.logicalBytes &&
    authoritative.logicalFiles === published.logicalFiles &&
    authoritative.manifestSha256 === published.manifestSha256 &&
    authoritative.protectedSourceRoot === published.protectedSourceRoot &&
    authoritative.protectionPolicyDigest === published.protectionPolicyDigest &&
    authoritative.protectionPolicyId === published.protectionPolicyId &&
    authoritative.releaseRoot === published.releaseRoot &&
    authoritative.version === published.version &&
    canonicalJson(publicProtectedFilesProjection(authoritative.protectedFiles)) ===
      canonicalJson(publicProtectedFilesProjection(published.protectedFiles))
  );
}

function completePublishedVersion(
  published: PublishedVersion | null
): published is PublishedVersion &
  Required<
    Pick<
      PublishedVersion,
      | 'activeContentDigest'
      | 'activePolicyVersion'
      | 'bindingRoot'
      | 'commonRoot'
      | 'logicalBytes'
      | 'logicalFiles'
      | 'manifestSha256'
      | 'protectedFiles'
      | 'protectedSourceRoot'
      | 'protectionPolicyDigest'
      | 'protectionPolicyId'
      | 'releaseRoot'
    >
  > {
  return Boolean(
    published?.activeContentDigest &&
      published.activePolicyVersion &&
      published.bindingRoot &&
      published.commonRoot &&
      published.manifestSha256 &&
      published.protectedFiles &&
      published.protectedSourceRoot &&
      published.protectionPolicyDigest &&
      published.protectionPolicyId &&
      published.releaseRoot &&
      Number.isSafeInteger(published.logicalBytes) &&
      (published.logicalBytes ?? -1) >= 0 &&
      Number.isSafeInteger(published.logicalFiles) &&
      (published.logicalFiles ?? 0) > 0
  );
}

function authorizedPublication(
  group: PackageInstallProductGroup,
  published: PublishedVersion | null,
  authoritative: AuthoritativePackageVersion | null
) {
  if (
    !completePublishedVersion(published) ||
    !authoritative ||
    !publicationMatchesAuthority(published, authoritative)
  ) {
    return null;
  }
  return {
    aliasId: group.aliasId,
    activeContentDigest: published.activeContentDigest,
    activePolicyVersion: published.activePolicyVersion,
    bindingRoot: published.bindingRoot,
    commonRoot: published.commonRoot,
    catalogProductIds: group.catalogProductIds,
    creatorId: group.creatorId,
    logicalBytes: published.logicalBytes,
    logicalFiles: published.logicalFiles,
    manifestSha256: published.manifestSha256,
    packageId: published.packageId,
    protectedFiles: published.protectedFiles,
    protectedSourceRoot: published.protectedSourceRoot,
    protectionPolicyDigest: published.protectionPolicyDigest,
    protectionPolicyId: published.protectionPolicyId,
    releaseRoot: published.releaseRoot,
    version: published.version,
    versionId: authoritative.id,
  };
}

export function createConvexPackageInstallAccess(
  config: PackageInstallAccessConfig
): PackageInstallAccessPort {
  async function serviceClient(buyerId?: string) {
    const actor = await createApiServiceActorBinding({
      ...(buyerId ? { authUserId: buyerId } : {}),
      service: 'package-install-sessions',
      scopes: ['downloads:service', 'entitlements:service'],
    });
    return {
      actor,
      convex: getConvexClientFromUrl(config.convexUrl, actor),
    };
  }

  return {
    async resolveDiagnosticsConsent(buyerId) {
      const { actor, convex } = await serviceClient(buyerId);
      const consent = (await convex.query(api.accountDiagnosticsConsent.getConsentForService, {
        actor,
        apiSecret: config.convexApiSecret,
        authUserId: buyerId,
      })) as { diagnosticsEnabled: boolean; diagnosticsSessionId: string | null };
      return {
        diagnosticsEnabled: consent.diagnosticsEnabled,
        diagnosticsSessionId: consent.diagnosticsSessionId,
      };
    },
    async resolveDiagnosticsSessionConsent(diagnosticsSessionId) {
      const { actor, convex } = await serviceClient();
      return convex.query(api.accountDiagnosticsConsent.getConsentForDiagnosticsSession, {
        actor,
        apiSecret: config.convexApiSecret,
        diagnosticsSessionId,
      });
    },
    async resolveProductGroup(aliasId) {
      const packageId = aliasId.trim();
      if (!packageId) {
        return null;
      }
      const { actor, convex } = await serviceClient();
      const context = (await convex.query(api.packageRegistry.getBuyerAccessContextByPackageId, {
        apiSecret: config.convexApiSecret,
        actor,
        packageId,
      })) as BuyerAccessContext | null;
      return context ? normalizeGroup(context) : null;
    },

    async resolveEntitledEdition(buyerId, group) {
      const { actor, convex } = await serviceClient(buyerId);
      const resolved = (await convex.query(api.packageEditions.resolveBuyerEdition, {
        apiSecret: config.convexApiSecret,
        actor,
        buyerAuthUserId: buyerId,
        catalogProductIds: group.catalogProductIds as Array<Id<'product_catalog'>>,
        packageId: group.packageId,
      })) as { editionId?: string } | null;
      return resolved?.editionId ?? null;
    },

    async resolvePublication(group, editionId, targetReleaseRoot) {
      const { actor, convex } = await serviceClient();
      const published = (await convex.query(api.packageVersions.resolveDownloadableVersion, {
        apiSecret: config.convexApiSecret,
        actor,
        editionId,
        packageId: group.packageId,
        ...(targetReleaseRoot ? { releaseRoot: targetReleaseRoot } : {}),
      })) as PublishedVersion | null;
      if (!completePublishedVersion(published)) {
        console.warn(
          JSON.stringify({
            editionId,
            event: 'package_install.publication_unresolved',
            packageId: group.packageId,
            stage: published ? 'incomplete-projection' : 'convex-null',
            targetReleaseRoot: targetReleaseRoot ?? null,
          })
        );
        return null;
      }
      const authoritative = await config.publicationAuthority.resolveReadyVersion({
        editionId,
        packageId: group.packageId,
        releaseRoot: published.releaseRoot,
      });
      const publication = authorizedPublication(group, published, authoritative);
      if (!publication) {
        console.warn(
          JSON.stringify({
            editionId,
            event: 'package_install.publication_unresolved',
            packageId: group.packageId,
            releaseRoot: published.releaseRoot,
            stage: authoritative ? 'authority-mismatch' : 'authority-null',
          })
        );
      }
      return publication;
    },

    async resolveInstalledRelease(group, editionId, releaseRoot) {
      const { actor, convex } = await serviceClient();
      const published = (await convex.query(api.packageVersions.resolveInstalledVersion, {
        apiSecret: config.convexApiSecret,
        actor,
        editionId,
        packageId: group.packageId,
        releaseRoot,
      })) as PublishedVersion | null;
      if (!completePublishedVersion(published) || published.releaseRoot !== releaseRoot) {
        return null;
      }
      const authoritative = await config.publicationAuthority.resolveInstalledVersion({
        editionId,
        packageId: group.packageId,
        releaseRoot,
      });
      return authorizedPublication(group, published, authoritative);
    },
  };
}
