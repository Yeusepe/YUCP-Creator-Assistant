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
    async resolveProductGroup(catalogProductIds) {
      const firstCatalogProductId = catalogProductIds[0];
      if (!firstCatalogProductId) {
        return null;
      }
      const { actor, convex } = await serviceClient();
      const context = (await convex.query(
        api.packageRegistry.getBuyerAccessContextByCatalogProductId,
        {
          apiSecret: config.convexApiSecret,
          actor,
          catalogProductId: firstCatalogProductId,
        }
      )) as BuyerAccessContext | null;
      return context ? normalizeGroup(context) : null;
    },

    async hasActiveEntitlement(buyerId, group, catalogProductId) {
      const storefront = group.storefronts.find(
        (candidate) => candidate.catalogProductId === catalogProductId
      );
      if (!storefront) {
        return false;
      }
      const { actor, convex } = await serviceClient(buyerId);
      let cursor: string | undefined;
      do {
        const result = (await convex.query(api.entitlements.listByAuthUser, {
          apiSecret: config.convexApiSecret,
          actor,
          authUserId: buyerId,
          scope: 'subject_holder',
          productId: storefront.productId,
          status: 'active',
          limit: 100,
          ...(cursor ? { cursor } : {}),
        })) as {
          data?: Array<{ catalogProductId?: Id<'product_catalog'> | null }>;
          hasMore?: boolean;
          nextCursor?: string | null;
        };
        if (
          result.data?.some(
            (entitlement) =>
              !entitlement.catalogProductId ||
              String(entitlement.catalogProductId) === catalogProductId
          )
        ) {
          return true;
        }
        cursor = result.hasMore && result.nextCursor ? result.nextCursor : undefined;
      } while (cursor);
      return false;
    },

    async resolvePublication(group, targetReleaseRoot) {
      const { actor, convex } = await serviceClient();
      const published = (await convex.query(api.packageVersions.resolveDownloadableVersion, {
        apiSecret: config.convexApiSecret,
        actor,
        packageId: group.packageId,
        ...(targetReleaseRoot ? { releaseRoot: targetReleaseRoot } : {}),
      })) as PublishedVersion | null;
      if (
        !published ||
        !published.activeContentDigest ||
        !published.activePolicyVersion ||
        !published.bindingRoot ||
        !published.commonRoot ||
        !published.manifestSha256 ||
        !published.protectedFiles ||
        !published.protectedSourceRoot ||
        !published.protectionPolicyDigest ||
        !published.protectionPolicyId ||
        !published.releaseRoot ||
        !Number.isSafeInteger(published.logicalBytes) ||
        (published.logicalBytes ?? -1) < 0 ||
        !Number.isSafeInteger(published.logicalFiles) ||
        (published.logicalFiles ?? 0) <= 0
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
        logicalBytes: published.logicalBytes as number,
        logicalFiles: published.logicalFiles as number,
        manifestSha256: published.manifestSha256,
        packageId: published.packageId,
        protectedFiles: published.protectedFiles,
        protectedSourceRoot: published.protectedSourceRoot,
        protectionPolicyDigest: published.protectionPolicyDigest,
        protectionPolicyId: published.protectionPolicyId,
        releaseRoot: published.releaseRoot,
        version: published.version,
        versionId: published.versionId,
      };
    },
  };
}
