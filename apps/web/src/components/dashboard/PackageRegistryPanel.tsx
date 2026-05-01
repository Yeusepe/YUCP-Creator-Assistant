import {
  Autocomplete,
  Button,
  Card,
  Checkbox,
  CheckboxGroup,
  Chip,
  Description,
  Label,
  ListBox,
  Radio,
  RadioGroup,
  SearchField,
  Select,
  TextArea,
  Tooltip,
  useFilter,
} from '@heroui/react';
import { DropZone, EmptyState, PressableFeedback, Sheet } from '@heroui-pro/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  resolveComparableYucpAliasIdsFromCatalogProduct,
  resolveSharedYucpAliasIdFromCatalogProducts,
  resolveYucpAliasIdFromCatalogProduct,
} from '@yucp/shared';
import {
  Archive,
  ArrowUpFromLine,
  Copy,
  ExternalLink,
  FolderUp,
  Package2,
  Pencil,
  RefreshCcw,
  Search,
  ShieldCheck,
  Store,
  Trash2,
} from 'lucide-react';
import type { ComponentPropsWithoutRef, Key, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { AccountInlineError } from '@/components/account/AccountPage';
import { PackageRegistryWorkspaceSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { type BadgeStatus, StatusChip } from '@/components/ui/StatusChip';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { YucpInput } from '@/components/ui/YucpInput';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import { getAccountProviderIconPath } from '@/lib/account';
import {
  archiveCreatorBackstageProduct,
  archiveCreatorBackstageRelease,
  archiveCreatorPackage,
  type BackstagePackageDependencyVersion,
  type CreatorBackstageCatalogTierSummary,
  type CreatorBackstagePackageReleaseSummary,
  type CreatorBackstageProductPackageSummary,
  type CreatorBackstageProductSummary,
  type CreatorPackageListResponse,
  type CreatorPackageSummary,
  deleteCreatorBackstageRelease,
  listCreatorBackstageProducts,
  listCreatorPackages,
  publishBackstageRelease,
  renameCreatorPackage,
  requestBackstageRepoAccess,
  restoreCreatorBackstageProduct,
  restoreCreatorPackage,
  uploadBackstageReleaseFileDirect,
} from '@/lib/packages';
import { buildBuyerProductAccessPath } from '@/lib/productAccess';
import { copyToClipboard } from '@/lib/utils';

interface PackageRegistryPanelProps {
  className?: string;
  description?: string;
  title?: string;
}

type PublishDraft = {
  catalogProductIds: string[];
  catalogTierIds: string[];
  accessMode: 'product' | 'tiers';
  laneKey: string;
  packageId: string;
  version: string;
  channel: string;
  displayName: string;
  description: string;
  repositoryVisibility: 'hidden' | 'listed';
  unityVersion: string;
  dependenciesText: string;
};

type SelectedUpload = {
  artifactKind: 'unitypackage' | 'zip';
  contentType: string;
  file: File;
  progressLabel?: string;
  progressValue?: number;
  status: 'ready' | 'uploading' | 'complete' | 'failed';
  errorMessage?: string;
};

type ProductLane = {
  catalogProductIds: string[];
  catalogTiers: CreatorBackstageCatalogTierSummary[];
  canArchive: boolean;
  canRestore: boolean;
  laneKey: string;
  packageLinks: CreatorBackstageProductPackageSummary[];
  primaryPackage: CreatorBackstageProductPackageSummary | null;
  products: CreatorBackstageProductSummary[];
  providerLabels: string[];
  providerRefs: string[];
  status: 'active' | 'archived';
  thumbnailUrl?: string;
  title: string;
};

const creatorPackagesQueryKey = ['creator-packages'] as const;
const creatorBackstageProductsQueryKey = ['creator-backstage-products'] as const;
const creatorBackstageProductsLiveSyncQueryKey = [
  'creator-backstage-products',
  'live-sync',
] as const;
const creatorBackstageRepoAccessQueryKey = ['creator-backstage-repo-access'] as const;
const UNITYPACKAGE_ACCEPT_VALUE = '.unitypackage,.zip,application/octet-stream,application/zip';

function joinClassNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function getBackstageArtifactKind(fileName: string): SelectedUpload['artifactKind'] | null {
  const normalized = fileName.trim().toLowerCase();
  if (normalized.endsWith('.unitypackage')) {
    return 'unitypackage';
  }
  if (normalized.endsWith('.zip')) {
    return 'zip';
  }
  return null;
}

function getBackstageArtifactContentType(
  file: Pick<File, 'name' | 'type'>,
  artifactKind: SelectedUpload['artifactKind']
): string {
  const normalizedType = file.type.trim();
  if (normalizedType) {
    return normalizedType;
  }
  return artifactKind === 'unitypackage' ? 'application/octet-stream' : 'application/zip';
}

function parseBackstageDependencyVersions(input: string): {
  dependencies: BackstagePackageDependencyVersion[];
  errorMessage?: string;
} {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { dependencies: [] };
  }

  const dependencyVersions = new Map<string, string>();
  for (const [index, line] of lines.entries()) {
    const separatorIndex = line.includes('=') ? line.indexOf('=') : line.lastIndexOf('@');
    if (separatorIndex <= 0 || separatorIndex >= line.length - 1) {
      return {
        dependencies: [],
        errorMessage: `Dependency line ${index + 1} must use com.package.id@1.0.0 or com.package.id=1.0.0.`,
      };
    }

    const packageId = line.slice(0, separatorIndex).trim();
    const version = line.slice(separatorIndex + 1).trim();
    if (!packageId || !version) {
      return {
        dependencies: [],
        errorMessage: `Dependency line ${index + 1} must include both a package ID and version.`,
      };
    }

    dependencyVersions.set(packageId, version);
  }

  return {
    dependencies: Array.from(dependencyVersions.entries()).map(([packageId, version]) => ({
      packageId,
      version,
    })),
  };
}

function updatePackageListCache(
  cached: CreatorPackageListResponse | undefined,
  packageId: string,
  updater: (pkg: CreatorPackageSummary) => CreatorPackageSummary
): CreatorPackageListResponse | undefined {
  if (!cached) {
    return cached;
  }

  return {
    ...cached,
    packages: cached.packages.map((pkg) => (pkg.packageId === packageId ? updater(pkg) : pkg)),
  };
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

function formatReleaseTimestamp(timestamp?: number): string {
  if (!timestamp) {
    return 'Pending publication';
  }

  return `${formatRelativeTime(timestamp)} · ${new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatProviderLabel(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function mapUploadStatus(status: SelectedUpload['status']): 'complete' | 'failed' | 'uploading' {
  if (status === 'failed') return 'failed';
  if (status === 'uploading') return 'uploading';
  return 'complete';
}

function mapReleaseStatus(status: CreatorBackstagePackageReleaseSummary['releaseStatus']): {
  status: Extract<BadgeStatus, 'active' | 'pending' | 'revoked'>;
  label: string;
} {
  switch (status) {
    case 'published':
      return { status: 'active', label: 'Published' };
    case 'revoked':
      return { status: 'revoked', label: 'Revoked' };
    case 'superseded':
      return { status: 'pending', label: 'Superseded' };
    default:
      return { status: 'pending', label: 'Draft' };
  }
}

function normalizeComparableText(value?: string): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

type ProductLaneMatchKeys = {
  aliasKeys: string[];
  fallbackKey: string;
  packageKeys: string[];
  softKeys: string[];
};

type ProductLaneGroup = {
  aliasKeys: Set<string>;
  packageKeys: Set<string>;
  products: CreatorBackstageProductSummary[];
  softKeys: Set<string>;
};

function buildUniqueMatchKeys(values: Array<string | undefined>, prefix: string): string[] {
  const normalizedValues = values
    .map((value) => normalizeComparableText(value))
    .filter(Boolean)
    .map((value) => `${prefix}:${value}`);
  return Array.from(new Set(normalizedValues));
}

function buildProductLaneMatchKeys(product: CreatorBackstageProductSummary): ProductLaneMatchKeys {
  return {
    aliasKeys: buildUniqueMatchKeys(
      [
        resolveYucpAliasIdFromCatalogProduct(product),
        ...resolveComparableYucpAliasIdsFromCatalogProduct(product),
      ],
      'alias'
    ),
    fallbackKey: `product:${String(product.catalogProductId)}`,
    packageKeys: buildUniqueMatchKeys(
      (product.backstagePackages ?? []).map((backstagePackage) => backstagePackage.packageId),
      'package'
    ),
    softKeys: buildUniqueMatchKeys(
      [...(product.aliases ?? []), product.displayName, product.providerProductRef],
      'soft'
    ),
  };
}

function groupHasMatch(groupKeys: Set<string>, keys: string[]): boolean {
  return keys.some((key) => groupKeys.has(key));
}

function collectMatchingProductLaneGroupIndexes(
  groups: ProductLaneGroup[],
  matchKeys: ProductLaneMatchKeys
): number[] {
  if (matchKeys.packageKeys.length > 0) {
    const packageMatches = groups.flatMap((group, index) =>
      groupHasMatch(group.packageKeys, matchKeys.packageKeys) ? [index] : []
    );
    if (packageMatches.length > 0) {
      return packageMatches;
    }
  }

  if (matchKeys.aliasKeys.length > 0) {
    const aliasMatches = groups.flatMap((group, index) =>
      groupHasMatch(group.aliasKeys, matchKeys.aliasKeys) ? [index] : []
    );
    if (aliasMatches.length > 0) {
      return aliasMatches;
    }
  }

  if (
    matchKeys.packageKeys.length === 0 &&
    matchKeys.aliasKeys.length === 0 &&
    matchKeys.softKeys.length > 0
  ) {
    const softMatches = groups.flatMap((group, index) =>
      groupHasMatch(group.softKeys, matchKeys.softKeys) ? [index] : []
    );
    if (softMatches.length > 0) {
      return softMatches;
    }
  }

  return [];
}

function appendProductLaneGroup(
  group: ProductLaneGroup,
  product: CreatorBackstageProductSummary,
  matchKeys: ProductLaneMatchKeys
) {
  group.products.push(product);
  for (const key of matchKeys.packageKeys) {
    group.packageKeys.add(key);
  }
  for (const key of matchKeys.aliasKeys) {
    group.aliasKeys.add(key);
  }
  for (const key of matchKeys.softKeys) {
    group.softKeys.add(key);
  }
}

function resolveUniqueAliasIdsForCatalogProducts(
  products: CreatorBackstageProductSummary[],
  catalogProductIds: string[]
): string[] {
  const selectedCatalogProductIds = new Set(
    catalogProductIds.map((catalogProductId) => String(catalogProductId))
  );
  const selectedProducts = products.filter((product) =>
    selectedCatalogProductIds.has(String(product.catalogProductId))
  );
  const sharedAliasId = resolveSharedYucpAliasIdFromCatalogProducts(selectedProducts);
  if (sharedAliasId) {
    return [sharedAliasId];
  }

  return Array.from(
    new Set(
      selectedProducts
        .map((product) => resolveYucpAliasIdFromCatalogProduct(product))
        .filter((aliasId): aliasId is string => Boolean(aliasId?.trim()))
    )
  );
}

function compareBackstagePackageLinks(
  left: CreatorBackstageProductPackageSummary,
  right: CreatorBackstageProductPackageSummary
): number {
  const leftLabel = (left.displayName ?? left.packageName ?? left.packageId).toLowerCase();
  const rightLabel = (right.displayName ?? right.packageName ?? right.packageId).toLowerCase();
  return leftLabel.localeCompare(rightLabel) || left.packageId.localeCompare(right.packageId);
}

function hasPackageUploads(backstagePackage: CreatorBackstageProductPackageSummary): boolean {
  return backstagePackage.releases.length > 0;
}

export function buildProductLanes(products: CreatorBackstageProductSummary[]): ProductLane[] {
  const groups: ProductLaneGroup[] = [];
  const prioritizedProducts = [...products].sort((left, right) => {
    const leftHasPackages = left.backstagePackages.length > 0 ? 1 : 0;
    const rightHasPackages = right.backstagePackages.length > 0 ? 1 : 0;
    return rightHasPackages - leftHasPackages;
  });

  for (const product of prioritizedProducts) {
    const matchKeys = buildProductLaneMatchKeys(product);
    const matchingIndexes = collectMatchingProductLaneGroupIndexes(groups, matchKeys);

    if (matchingIndexes.length === 0) {
      const newGroup: ProductLaneGroup = {
        aliasKeys: new Set<string>(),
        packageKeys: new Set<string>(),
        products: [],
        softKeys: new Set<string>([matchKeys.fallbackKey]),
      };
      appendProductLaneGroup(newGroup, product, matchKeys);
      groups.push(newGroup);
      continue;
    }

    const [targetIndex, ...mergeIndexes] = matchingIndexes;
    const targetGroup = groups[targetIndex];
    if (!targetGroup) {
      continue;
    }

    appendProductLaneGroup(targetGroup, product, matchKeys);

    for (const mergeIndex of [...mergeIndexes].sort((left, right) => right - left)) {
      const mergeGroup = groups[mergeIndex];
      if (!mergeGroup) {
        continue;
      }
      for (const mergedProduct of mergeGroup.products) {
        targetGroup.products.push(mergedProduct);
      }
      for (const key of mergeGroup.packageKeys) {
        targetGroup.packageKeys.add(key);
      }
      for (const key of mergeGroup.aliasKeys) {
        targetGroup.aliasKeys.add(key);
      }
      for (const key of mergeGroup.softKeys) {
        targetGroup.softKeys.add(key);
      }
      groups.splice(mergeIndex, 1);
    }
  }

  return groups
    .map((group) => {
      const laneProducts = group.products;
      const laneKey =
        Array.from(group.packageKeys)[0] ??
        Array.from(group.aliasKeys)[0] ??
        Array.from(group.softKeys)[0];
      const primaryTitle =
        laneProducts.find((product) => product.displayName?.trim())?.displayName?.trim() ??
        laneProducts[0]?.productId ??
        'Untitled product';
      const packageLinks = Array.from(
        new Map(
          laneProducts
            .flatMap((product) => product.backstagePackages)
            .filter(hasPackageUploads)
            .map((backstagePackage) => [backstagePackage.packageId, backstagePackage])
        ).values()
      ).sort(compareBackstagePackageLinks);
      const providerLabels = Array.from(
        new Map(
          laneProducts.map((product) => [product.provider, formatProviderLabel(product.provider)])
        ).values()
      );
      const providerRefs = laneProducts.map(
        (product) => `${formatProviderLabel(product.provider)} · ${product.providerProductRef}`
      );
      const catalogTiers = Array.from(
        new Map(
          laneProducts
            .flatMap((product) => product.catalogTiers ?? [])
            .filter((tier) => tier.status === 'active')
            .map((tier) => [tier.catalogTierId, tier])
        ).values()
      ).sort((left, right) => left.displayName.localeCompare(right.displayName));
      const status: ProductLane['status'] = laneProducts.every(
        (product) => product.status === 'archived'
      )
        ? 'archived'
        : 'active';

      return {
        catalogProductIds: laneProducts.map((product) => product.catalogProductId),
        catalogTiers,
        canArchive: laneProducts.some((product) => product.canArchive),
        canRestore: laneProducts.some((product) => product.canRestore),
        laneKey,
        packageLinks,
        primaryPackage: packageLinks.length === 1 ? packageLinks[0] : null,
        products: [...laneProducts].sort((left, right) =>
          formatProviderLabel(left.provider).localeCompare(formatProviderLabel(right.provider))
        ),
        providerLabels,
        providerRefs,
        status,
        thumbnailUrl: laneProducts.find((product) => product.thumbnailUrl)?.thumbnailUrl,
        title: primaryTitle,
      };
    })
    .sort((left, right) => left.title.localeCompare(right.title));
}

function buildDraftFromLane(lane?: ProductLane | null): PublishDraft {
  const linkedPackage = lane?.primaryPackage ?? null;
  return {
    catalogProductIds: lane?.catalogProductIds ?? [],
    catalogTierIds: [],
    accessMode: 'product',
    laneKey: lane?.laneKey ?? '',
    packageId: linkedPackage?.packageId ?? '',
    version: '',
    channel: linkedPackage?.defaultChannel ?? 'stable',
    displayName: linkedPackage?.displayName ?? lane?.title ?? '',
    description: '',
    repositoryVisibility: linkedPackage?.repositoryVisibility ?? 'listed',
    unityVersion: '',
    dependenciesText: '',
  };
}

function formatLaneStorefrontSummary(lane: ProductLane): string {
  const storefrontLabel = `${lane.products.length} storefront${lane.products.length === 1 ? '' : 's'}`;
  return `${storefrontLabel} · ${lane.providerLabels.join(', ')}`;
}

function getLaneSearchText(lane: ProductLane): string {
  return [
    lane.title,
    ...lane.providerLabels,
    ...lane.products.flatMap((product) => [
      product.displayName,
      product.canonicalSlug ?? '',
      product.providerProductRef,
      ...(product.aliases ?? []),
    ]),
    ...lane.packageLinks.flatMap((packageLink) => [
      packageLink.packageId,
      packageLink.packageName ?? '',
      packageLink.displayName ?? '',
    ]),
  ]
    .join(' ')
    .trim();
}

function formatTierPrice(tier: CreatorBackstageCatalogTierSummary): string | null {
  if (tier.amountCents == null || !tier.currency) {
    return null;
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: tier.currency.toUpperCase(),
    }).format(tier.amountCents / 100);
  } catch {
    return `${(tier.amountCents / 100).toFixed(2)} ${tier.currency.toUpperCase()}`;
  }
}

function StreamlineLinkChainIcon(props: ComponentPropsWithoutRef<'svg'>) {
  const { className, ...restProps } = props;
  return (
    <svg
      fill="none"
      viewBox="0 0 14 14"
      className={joinClassNames('text-primary', className)}
      aria-hidden="true"
      focusable="false"
      {...restProps}
    >
      <path
        fill="currentColor"
        opacity="0.78"
        fillRule="evenodd"
        d="M12.399 1.601C11.197 0.4 9.874 0.041 8.504 0.361c-1.289 0.3 -2.54 1.181 -3.734 2.233a0.75 0.75 0 0 0 0.99 1.126C6.92 2.7 7.936 2.033 8.844 1.822c0.825 -0.193 1.628 -0.026 2.494 0.84 0.86 0.86 1.03 1.656 0.846 2.472 -0.202 0.896 -0.85 1.9 -1.852 3.046a0.75 0.75 0 0 0 1.129 0.988c1.035 -1.185 1.898 -2.426 2.186 -3.705 0.306 -1.36 -0.057 -2.67 -1.248 -3.862ZM9.388 4.613a0.75 0.75 0 0 1 0 1.06L5.673 9.388a0.75 0.75 0 0 1 -1.06 -1.06l3.714 -3.715a0.75 0.75 0 0 1 1.061 0Zm-5.79 0.148a0.75 0.75 0 0 1 0.07 1.059c-1.001 1.145 -1.65 2.15 -1.851 3.046 -0.184 0.816 -0.015 1.612 0.845 2.472 0.866 0.866 1.669 1.033 2.494 0.84 0.908 -0.211 1.925 -0.877 3.083 -1.898a0.75 0.75 0 1 1 0.991 1.126c-1.194 1.052 -2.445 1.933 -3.733 2.233 -1.371 0.32 -2.693 -0.038 -3.896 -1.24C0.411 11.208 0.047 9.898 0.353 8.537c0.288 -1.28 1.15 -2.52 2.186 -3.705a0.75 0.75 0 0 1 1.059 -0.07Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function StreamlineShippingBoxIcon(props: ComponentPropsWithoutRef<'svg'>) {
  const { className, ...restProps } = props;
  return (
    <svg
      fill="none"
      viewBox="0 0 14 14"
      className={joinClassNames('text-accent', className)}
      aria-hidden="true"
      focusable="false"
      {...restProps}
    >
      <path
        fill="currentColor"
        opacity="0.3"
        d="M11.71 2.314a18.695 18.695 0 0 1 -0.64 -1.28 1.066 1.066 0 0 0 -0.888 -0.63A35.212 35.212 0 0 0 7 0.256c-1.269 0 -2.148 0.06 -3.211 0.149a1.054 1.054 0 0 0 -0.868 0.596c-0.17 0.365 -0.363 0.73 -0.559 1.099 -0.395 0.75 -0.802 1.91 -1.06 2.743 0.17 -0.25 0.46 -0.423 0.795 -0.446 0.294 -0.021 0.592 -0.044 0.891 -0.067 1.296 -0.098 2.638 -0.2 4.012 -0.2 1.374 0 2.716 0.102 4.011 0.2 0.3 0.023 0.597 0.046 0.892 0.067 0.333 0.023 0.623 0.194 0.793 0.444 -0.268 -0.792 -0.633 -1.866 -0.986 -2.528Z"
      />
      <path
        fill="currentColor"
        opacity="0.94"
        fillRule="evenodd"
        d="m6.376 4.139 -0.001 -0.033V0.262C5.422 0.28 4.669 0.333 3.788 0.406a1.054 1.054 0 0 0 -0.867 0.596c-0.17 0.365 -0.363 0.73 -0.559 1.1 -0.395 0.749 -0.802 1.91 -1.06 2.742 0.17 -0.25 0.46 -0.422 0.794 -0.446l0.892 -0.066c1.099 -0.084 2.23 -0.17 3.388 -0.193Zm1.248 0c1.157 0.024 2.288 0.11 3.387 0.193l0.892 0.066c0.333 0.024 0.623 0.194 0.793 0.444l-0.001 -0.005c-0.269 -0.791 -0.632 -1.862 -0.985 -2.523a18.648 18.648 0 0 1 -0.64 -1.28 1.066 1.066 0 0 0 -0.888 -0.63A36.971 36.971 0 0 0 7.625 0.261v3.844l-0.001 0.033Z"
        clipRule="evenodd"
      />
      <path
        fill="currentColor"
        opacity="0.4"
        d="M1.155 11.994c0.074 0.496 0.464 0.879 0.941 0.917 1.569 0.127 3.211 0.302 4.904 0.302 1.692 0 3.335 -0.175 4.903 -0.302 0.477 -0.038 0.867 -0.42 0.94 -0.917 0.162 -1.084 0.355 -2.214 0.355 -3.376 0 -1.163 -0.193 -2.293 -0.354 -3.377 -0.074 -0.496 -0.464 -0.878 -0.941 -0.917 -1.568 -0.127 -3.211 -0.302 -4.903 -0.302 -1.693 0 -3.335 0.175 -4.904 0.302 -0.477 0.039 -0.867 0.42 -0.94 0.917C0.993 6.325 0.801 7.455 0.801 8.618c0 1.162 0.192 2.292 0.353 3.376Z"
      />
      <path
        fill="currentColor"
        opacity="0.82"
        fillRule="evenodd"
        d="M8.067 10.575c0 -0.345 0.28 -0.625 0.625 -0.625h2.021a0.625 0.625 0 0 1 0 1.25h-2.02a0.625 0.625 0 0 1 -0.626 -0.625Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function StreamlineArchiveBoxIcon(props: ComponentPropsWithoutRef<'svg'>) {
  const { className, ...restProps } = props;
  return (
    <svg
      fill="none"
      viewBox="0 0 14 14"
      className={joinClassNames('text-primary', className)}
      aria-hidden="true"
      focusable="false"
      {...restProps}
    >
      <path
        fill="currentColor"
        opacity="0.32"
        fillRule="evenodd"
        d="M1.55 5.381c0.157 0.05 0.32 0.073 0.482 0.07 2.352 -0.04 4.722 -0.023 7.137 -0.006 1.044 0.007 2.096 0.015 3.158 0.017 0.048 0 0.096 -0.002 0.144 -0.006 0.024 0.073 0.043 0.15 0.056 0.228a19.45 19.45 0 0 1 0.262 3.144 19.96 19.96 0 0 1 -0.283 3.227 1.467 1.467 0 0 1 -1.289 1.219c-1.352 0.15 -2.757 0.25 -4.217 0.25 -1.198 0 -2.37 -0.108 -3.476 -0.21l-0.002 0c-0.235 -0.022 -0.467 -0.044 -0.696 -0.063a1.483 1.483 0 0 1 -1.344 -1.221 19.34 19.34 0 0 1 -0.013 -6.358c0.017 -0.102 0.044 -0.2 0.08 -0.29Z"
        clipRule="evenodd"
      />
      <path
        fill="currentColor"
        opacity="0.94"
        fillRule="evenodd"
        d="M4.933 8.11c0 -0.345 0.28 -0.624 0.625 -0.624h2.884a0.625 0.625 0 1 1 0 1.25H5.558a0.625 0.625 0 0 1 -0.625 -0.625Z"
        clipRule="evenodd"
      />
      <path
        fill="currentColor"
        opacity="0.74"
        fillRule="evenodd"
        d="M7 0.77c-1.815 0 -3.582 0.044 -5.25 0.124 -0.497 0.024 -1.016 0.304 -1.225 0.843A4.03 4.03 0 0 0 0.25 3.193c0 0.48 0.093 0.94 0.254 1.38 0.218 0.594 0.8 0.888 1.347 0.879 2.352 -0.04 4.723 -0.024 7.137 -0.007 1.045 0.007 2.097 0.015 3.159 0.017 0.56 0.002 1.13 -0.315 1.343 -0.902a4 4 0 0 0 0.26 -1.367c0 -0.499 -0.102 -0.98 -0.274 -1.433 -0.208 -0.548 -0.732 -0.842 -1.245 -0.865A112.353 112.353 0 0 0 7 0.77Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function IconActionButton({
  label,
  onPress,
  isDisabled,
  children,
}: {
  label: string;
  onPress: () => void;
  isDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip delay={0}>
      <Button
        isIconOnly
        aria-label={label}
        isDisabled={isDisabled}
        size="sm"
        variant="ghost"
        onPress={onPress}
      >
        {children}
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}

function ProductLaneCard({
  buyerAccessUrl,
  lane,
  isRestoring,
  onCopyBuyerAccess,
  onOpenDetails,
  onPublish,
  onRestore,
}: {
  buyerAccessUrl?: string | null;
  lane: ProductLane;
  isRestoring: boolean;
  onCopyBuyerAccess?: (url: string) => void;
  onOpenDetails: (lane: ProductLane) => void;
  onPublish: (lane: ProductLane) => void;
  onRestore: (lane: ProductLane) => void;
}) {
  const linkedPackage = lane.primaryPackage;
  const providerIconPath = getAccountProviderIconPath(lane.products[0]?.provider);
  const hasPackageConflict = lane.packageLinks.length > 1;
  const archived = lane.status === 'archived';
  const busy = isRestoring;
  const primaryActionLabel = archived
    ? 'Restore'
    : hasPackageConflict
      ? 'Pick ID'
      : linkedPackage
        ? 'Upload'
        : 'Set up';
  const rowSummary = hasPackageConflict
    ? 'Choose the install ID you want to keep using before you upload.'
    : linkedPackage
      ? [
          `Install ID: ${linkedPackage.packageId}`,
          linkedPackage.latestPublishedVersion
            ? `Live version ${linkedPackage.latestPublishedVersion}`
            : 'No live update yet',
        ].join(' · ')
      : `Needs first install ID · ${formatLaneStorefrontSummary(lane)}`;

  return (
    <Card className="pm-product-row rounded-xl shadow-none">
      <Card.Content className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <button
          type="button"
          className="group flex min-w-0 flex-1 gap-3 text-left"
          aria-label={`Open past uploads for ${lane.title}`}
          onClick={() => onOpenDetails(lane)}
        >
          <div className="pm-icon-shell flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl">
            {lane.thumbnailUrl ? (
              <img
                src={lane.thumbnailUrl}
                alt=""
                aria-hidden="true"
                className="size-full object-cover"
              />
            ) : providerIconPath ? (
              <img
                src={providerIconPath}
                alt=""
                aria-hidden="true"
                className="size-7 object-contain"
              />
            ) : (
              <Store className="size-5" />
            )}
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-foreground min-w-0 truncate text-sm font-semibold leading-6 group-hover:underline">
                {lane.title}
              </p>
              {hasPackageConflict ? (
                <Chip color="warning" size="sm" variant="soft">
                  Pick install ID
                </Chip>
              ) : null}
              {archived ? (
                <Chip size="sm" variant="soft">
                  Hidden
                </Chip>
              ) : null}
            </div>
            <p className="pm-copy break-all text-sm leading-6">{rowSummary}</p>
          </div>
        </button>
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          {buyerAccessUrl && onCopyBuyerAccess ? (
            <Button
              size="sm"
              variant="ghost"
              isDisabled={busy}
              onPress={() => onCopyBuyerAccess(buyerAccessUrl)}
            >
              <Copy className="size-4" />
              Copy store-page link
            </Button>
          ) : null}
          {!archived ? (
            <Button size="sm" variant="outline" isDisabled={busy} onPress={() => onPublish(lane)}>
              <ArrowUpFromLine className="size-4" />
              {primaryActionLabel}
            </Button>
          ) : null}
          {archived ? (
            <Button
              size="sm"
              variant="outline"
              isDisabled={busy || !lane.canRestore}
              onPress={() => onRestore(lane)}
            >
              {isRestoring ? (
                <span className="btn-loading-spinner" aria-hidden="true" />
              ) : (
                <RefreshCcw className="size-4" />
              )}
              {isRestoring ? 'Restoring...' : 'Restore'}
            </Button>
          ) : null}
        </div>
      </Card.Content>
    </Card>
  );
}

function HoldToDeleteReleaseButton({
  isDeleting,
  isDisabled,
  onDelete,
}: {
  isDeleting: boolean;
  isDisabled: boolean;
  onDelete: () => void;
}) {
  return (
    <Button
      aria-label="Hold to delete upload"
      size="sm"
      variant="ghost"
      className="text-danger"
      isDisabled={isDisabled}
    >
      {!isDeleting ? (
        <PressableFeedback.HoldConfirm
          className="bg-danger text-danger-foreground"
          isDisabled={isDisabled}
          onComplete={onDelete}
        >
          <Trash2 className="size-4" />
          Hold to delete
        </PressableFeedback.HoldConfirm>
      ) : null}
      {isDeleting ? (
        <span className="btn-loading-spinner" aria-hidden="true" />
      ) : (
        <Trash2 className="size-4" />
      )}
      {isDeleting ? 'Deleting...' : 'Hold to delete'}
    </Button>
  );
}

function ProductLaneDetailsSheet({
  buyerAccessUrl,
  isArchiving,
  archivingReleaseId,
  deletingReleaseId,
  isRestoring,
  lane,
  isOpen,
  onArchive,
  onArchiveRelease,
  onCopyBuyerAccess,
  onCopyPackageId,
  onDeleteRelease,
  onOpenChange,
  onPublish,
  onRestore,
}: {
  buyerAccessUrl?: string | null;
  isArchiving: boolean;
  archivingReleaseId: string | null;
  deletingReleaseId: string | null;
  isRestoring: boolean;
  lane: ProductLane | null;
  isOpen: boolean;
  onArchive: (lane: ProductLane) => void;
  onArchiveRelease: (packageId: string, release: CreatorBackstagePackageReleaseSummary) => void;
  onCopyBuyerAccess: (url: string) => void;
  onCopyPackageId: (packageId: string) => void;
  onDeleteRelease: (packageId: string, release: CreatorBackstagePackageReleaseSummary) => void;
  onOpenChange: (isOpen: boolean) => void;
  onPublish: (lane: ProductLane) => void;
  onRestore: (lane: ProductLane) => void;
}) {
  return (
    <Sheet isOpen={isOpen} onOpenChange={onOpenChange}>
      <Sheet.Backdrop variant="blur">
        <Sheet.Content className="mx-auto max-h-[94vh] max-w-[860px]">
          <Sheet.Dialog>
            <Sheet.Handle />
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>Past uploads</Sheet.Heading>
            </Sheet.Header>
            <Sheet.Body className="space-y-5">
              {lane ? (
                <>
                  <Card className="pm-muted-card rounded-2xl shadow-none">
                    <Card.Content className="space-y-4 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <p className="text-foreground text-base font-semibold">{lane.title}</p>
                          <p className="pm-subtle-copy text-sm">
                            {lane.products.length} storefront
                            {lane.products.length === 1 ? '' : 's'} ·{' '}
                            {lane.providerLabels.join(', ')}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {buyerAccessUrl ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onPress={() => onCopyBuyerAccess(buyerAccessUrl)}
                            >
                              <Copy className="size-4" />
                              Copy store-page link
                            </Button>
                          ) : null}
                          {lane.status === 'archived' ? (
                            <Button
                              size="sm"
                              variant="outline"
                              isDisabled={isRestoring || !lane.canRestore}
                              onPress={() => onRestore(lane)}
                            >
                              {isRestoring ? (
                                <span className="btn-loading-spinner" aria-hidden="true" />
                              ) : (
                                <RefreshCcw className="size-4" />
                              )}
                              {isRestoring ? 'Restoring...' : 'Restore'}
                            </Button>
                          ) : (
                            <>
                              <Button size="sm" variant="outline" onPress={() => onPublish(lane)}>
                                <ArrowUpFromLine className="size-4" />
                                Upload update
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                isDisabled={isArchiving || !lane.canArchive}
                                onPress={() => onArchive(lane)}
                              >
                                {isArchiving ? (
                                  <span className="btn-loading-spinner" aria-hidden="true" />
                                ) : (
                                  <Archive className="size-4" />
                                )}
                                {isArchiving ? 'Hiding...' : 'Hide link'}
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {lane.providerRefs.map((providerRef) => (
                          <Chip key={providerRef} size="sm" variant="soft">
                            {providerRef}
                          </Chip>
                        ))}
                      </div>
                      {buyerAccessUrl ? (
                        <div className="pm-inline-note rounded-[18px] p-3">
                          <p className="text-foreground text-sm font-semibold">
                            Store page distribution
                          </p>
                          <p className="pm-subtle-copy mt-1 text-sm leading-6">
                            Put the YUCP access page on your store page or delivery instructions.
                            Buyers should start there, then sign in, verify purchase, and add the
                            repo in VCC.
                          </p>
                        </div>
                      ) : null}
                    </Card.Content>
                  </Card>

                  {lane.packageLinks.length > 0 ? (
                    lane.packageLinks.map((packageLink) => (
                      <Card key={packageLink.packageId} className="pm-card rounded-2xl shadow-none">
                        <Card.Header className="flex flex-wrap items-start justify-between gap-3 p-4 pb-2">
                          <div className="space-y-1">
                            <p className="text-foreground text-sm font-semibold">
                              {packageLink.displayName ??
                                packageLink.packageName ??
                                packageLink.packageId}
                            </p>
                            <p className="text-muted break-all font-mono text-xs">
                              {packageLink.packageId}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onPress={() => onCopyPackageId(packageLink.packageId)}
                            >
                              <Copy className="size-4" />
                              Copy install ID
                            </Button>
                            <Button size="sm" variant="outline" onPress={() => onPublish(lane)}>
                              <ArrowUpFromLine className="size-4" />
                              Upload update
                            </Button>
                          </div>
                        </Card.Header>
                        <Card.Content className="space-y-3 p-4 pt-0">
                          {packageLink.releases.filter(
                            (release) => release.releaseStatus !== 'revoked'
                          ).length > 0 ? (
                            packageLink.releases
                              .filter((release) => release.releaseStatus !== 'revoked')
                              .map((release) => {
                                const releaseBadge = mapReleaseStatus(release.releaseStatus);
                                const isCurrentRelease =
                                  packageLink.latestRelease?.deliveryPackageReleaseId ===
                                  release.deliveryPackageReleaseId;
                                const isArchivingRelease =
                                  archivingReleaseId === release.deliveryPackageReleaseId;
                                const isDeletingRelease =
                                  deletingReleaseId === release.deliveryPackageReleaseId;

                                return (
                                  <div key={release.deliveryPackageReleaseId}>
                                    <div className="pm-muted-panel space-y-3 rounded-2xl p-4">
                                      <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="space-y-1">
                                          <p className="text-foreground text-sm font-medium">
                                            {release.deliveryName ??
                                              `${packageLink.packageId}-${release.version}.zip`}
                                          </p>
                                          <p className="text-muted text-xs">
                                            {formatReleaseTimestamp(
                                              release.publishedAt ?? release.updatedAt
                                            )}
                                          </p>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                          <StatusChip
                                            status={releaseBadge.status}
                                            label={releaseBadge.label}
                                          />
                                          {isCurrentRelease ? (
                                            <>
                                              <Chip size="sm" variant="soft">
                                                Current
                                              </Chip>
                                              <HoldToDeleteReleaseButton
                                                isDeleting={isDeletingRelease}
                                                isDisabled={isArchivingRelease || isDeletingRelease}
                                                onDelete={() =>
                                                  onDeleteRelease(packageLink.packageId, release)
                                                }
                                              />
                                            </>
                                          ) : (
                                            <>
                                              <Button
                                                size="sm"
                                                variant="ghost"
                                                isDisabled={
                                                  isArchivingRelease ||
                                                  isDeletingRelease ||
                                                  lane.status === 'archived'
                                                }
                                                onPress={() => {
                                                  onArchiveRelease(packageLink.packageId, release);
                                                }}
                                              >
                                                {isArchivingRelease ? (
                                                  <span
                                                    className="btn-loading-spinner"
                                                    aria-hidden="true"
                                                  />
                                                ) : (
                                                  <Archive className="size-4" />
                                                )}
                                                {isArchivingRelease
                                                  ? 'Archiving...'
                                                  : 'Archive upload'}
                                              </Button>
                                              <HoldToDeleteReleaseButton
                                                isDeleting={isDeletingRelease}
                                                isDisabled={isArchivingRelease || isDeletingRelease}
                                                onDelete={() =>
                                                  onDeleteRelease(packageLink.packageId, release)
                                                }
                                              />
                                            </>
                                          )}
                                        </div>
                                      </div>
                                      <div className="flex flex-wrap gap-2">
                                        <Chip size="sm" variant="soft">
                                          v{release.version}
                                        </Chip>
                                        <Chip size="sm" variant="soft">
                                          {release.channel}
                                        </Chip>
                                        <Chip size="sm" variant="soft">
                                          {release.repositoryVisibility === 'listed'
                                            ? 'Listed'
                                            : 'Hidden'}
                                        </Chip>
                                        {release.unityVersion ? (
                                          <Chip size="sm" variant="soft">
                                            Unity {release.unityVersion}
                                          </Chip>
                                        ) : null}
                                        {release.contentType ? (
                                          <Chip size="sm" variant="soft">
                                            {release.contentType}
                                          </Chip>
                                        ) : null}
                                      </div>
                                      {release.zipSha256 ? (
                                        <p className="text-muted break-all font-mono text-[11px]">
                                          SHA-256 {release.zipSha256}
                                        </p>
                                      ) : null}
                                    </div>
                                  </div>
                                );
                              })
                          ) : (
                            <EmptyState className="pm-empty-state rounded-2xl border border-dashed">
                              <EmptyState.Header>
                                <EmptyState.Media variant="icon">
                                  <Package2 className="size-5" />
                                </EmptyState.Media>
                                <EmptyState.Title>No uploads yet</EmptyState.Title>
                                <EmptyState.Description>
                                  Upload the first update for this install ID to start its history.
                                </EmptyState.Description>
                              </EmptyState.Header>
                            </EmptyState>
                          )}
                          {packageLink.releases.some(
                            (release) => release.releaseStatus === 'revoked'
                          ) ? (
                            <details className="pm-muted-panel rounded-2xl p-4">
                              <summary className="text-foreground cursor-pointer list-none text-sm font-medium">
                                Archived uploads
                              </summary>
                              <div className="mt-4 space-y-3">
                                {packageLink.releases
                                  .filter((release) => release.releaseStatus === 'revoked')
                                  .map((release) => (
                                    <div
                                      key={release.deliveryPackageReleaseId}
                                      className="pm-muted-panel space-y-2 rounded-2xl p-4"
                                    >
                                      <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="space-y-1">
                                          <p className="text-foreground text-sm font-medium">
                                            {release.deliveryName ??
                                              `${packageLink.packageId}-${release.version}.zip`}
                                          </p>
                                          <p className="text-muted text-xs">
                                            {formatReleaseTimestamp(
                                              release.publishedAt ?? release.updatedAt
                                            )}
                                          </p>
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2">
                                          <StatusChip status="revoked" label="Archived" />
                                          <HoldToDeleteReleaseButton
                                            isDeleting={
                                              deletingReleaseId === release.deliveryPackageReleaseId
                                            }
                                            isDisabled={
                                              archivingReleaseId ===
                                                release.deliveryPackageReleaseId ||
                                              deletingReleaseId === release.deliveryPackageReleaseId
                                            }
                                            onDelete={() =>
                                              onDeleteRelease(packageLink.packageId, release)
                                            }
                                          />
                                        </div>
                                      </div>
                                      <div className="flex flex-wrap gap-2">
                                        <Chip size="sm" variant="soft">
                                          v{release.version}
                                        </Chip>
                                        <Chip size="sm" variant="soft">
                                          {release.channel}
                                        </Chip>
                                      </div>
                                    </div>
                                  ))}
                              </div>
                            </details>
                          ) : null}
                        </Card.Content>
                      </Card>
                    ))
                  ) : (
                    <EmptyState className="pm-empty-state rounded-2xl border border-dashed">
                      <EmptyState.Header>
                        <EmptyState.Media variant="icon">
                          <Store />
                        </EmptyState.Media>
                        <EmptyState.Title>No package uploads yet</EmptyState.Title>
                        <EmptyState.Description>
                          This product does not have an install ID yet. Upload one to create the
                          first installable update.
                        </EmptyState.Description>
                      </EmptyState.Header>
                    </EmptyState>
                  )}
                </>
              ) : null}
            </Sheet.Body>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  );
}

function PackageRegistryItem({
  pkg,
  isEditing,
  editName,
  isSaving,
  isArchiving,
  isRestoring,
  onEditStart,
  onEditCancel,
  onEditChange,
  onSave,
  onArchive,
  onRestore,
  onCopyId,
}: {
  pkg: CreatorPackageSummary;
  isEditing: boolean;
  editName: string;
  isSaving: boolean;
  isArchiving: boolean;
  isRestoring: boolean;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditChange: (value: string) => void;
  onSave: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onCopyId: () => void;
}) {
  const archived = pkg.status === 'archived';
  const busy = isSaving || isArchiving || isRestoring;
  const nameChanged = editName.trim() !== (pkg.packageName ?? '').trim();
  const packageMeta = `Updated ${formatRelativeTime(pkg.updatedAt)} · ${archived ? 'Hidden' : 'Active'}`;

  return (
    <Card className="pm-package-row rounded-xl shadow-none">
      <Card.Content className="grid gap-3 p-3.5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="flex min-w-0 gap-3">
          <div className="pm-icon-shell flex size-11 shrink-0 items-center justify-center rounded-xl">
            {archived ? (
              <StreamlineArchiveBoxIcon className="size-7" />
            ) : (
              <Package2 className="text-accent size-5" />
            )}
          </div>
          <div className="min-w-0 space-y-2">
            {isEditing ? (
              <div className="w-full space-y-2">
                <YucpInput
                  aria-label="Package name"
                  value={editName}
                  autoFocus
                  isDisabled={isSaving}
                  onValueChange={onEditChange}
                />
                <p className="text-muted break-all font-mono text-xs leading-5">{pkg.packageId}</p>
                <p className="text-muted text-sm">{packageMeta}</p>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-foreground text-sm font-semibold leading-6">
                  {pkg.packageName || 'Unnamed package'}
                </p>
                <p className="text-muted break-all text-xs leading-5">
                  <span className="font-mono">{pkg.packageId}</span>
                  <span aria-hidden="true"> · </span>
                  <span>{packageMeta}</span>
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {isEditing ? (
            <>
              <Button
                isDisabled={!nameChanged || isSaving}
                size="sm"
                variant="primary"
                onPress={onSave}
              >
                {isSaving ? (
                  <span className="btn-loading-spinner" aria-hidden="true" />
                ) : (
                  <ShieldCheck className="size-4" />
                )}
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
              <Button size="sm" variant="ghost" isDisabled={isSaving} onPress={onEditCancel}>
                <RefreshCcw className="size-4" />
                Cancel
              </Button>
            </>
          ) : (
            <>
              <IconActionButton label="Copy install ID" onPress={onCopyId}>
                <Copy className="size-4" />
              </IconActionButton>
              {!archived ? (
                <Button size="sm" variant="ghost" isDisabled={busy} onPress={onEditStart}>
                  <Pencil className="size-4" />
                  Rename
                </Button>
              ) : null}
              {archived ? (
                <Button
                  size="sm"
                  variant="outline"
                  isDisabled={busy || !pkg.canRestore}
                  onPress={onRestore}
                >
                  {isRestoring ? (
                    <span className="btn-loading-spinner" aria-hidden="true" />
                  ) : (
                    <RefreshCcw className="size-4" />
                  )}
                  {isRestoring ? 'Restoring...' : 'Restore'}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={busy || !pkg.canArchive}
                  onPress={onArchive}
                >
                  {isArchiving ? (
                    <span className="btn-loading-spinner" aria-hidden="true" />
                  ) : (
                    <Archive className="size-4" />
                  )}
                  {isArchiving ? 'Hiding...' : 'Hide'}
                </Button>
              )}
            </>
          )}
        </div>
      </Card.Content>
    </Card>
  );
}

export function PackageRegistryPanel({
  className = 'bento-col-12',
  description = 'Pick a product and upload the file.',
  title = 'Packages',
}: PackageRegistryPanelProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { canRunPanelQueries, markSessionExpired } = useDashboardSession();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [pendingSaveId, setPendingSaveId] = useState<string | null>(null);
  const [pendingArchiveId, setPendingArchiveId] = useState<string | null>(null);
  const [pendingRestoreId, setPendingRestoreId] = useState<string | null>(null);
  const [pendingProductArchiveKey, setPendingProductArchiveKey] = useState<string | null>(null);
  const [pendingProductRestoreKey, setPendingProductRestoreKey] = useState<string | null>(null);
  const [pendingReleaseArchiveId, setPendingReleaseArchiveId] = useState<string | null>(null);
  const [pendingReleaseDeleteId, setPendingReleaseDeleteId] = useState<string | null>(null);
  const [isPublishOpen, setIsPublishOpen] = useState(false);
  const [isProductDetailsOpen, setIsProductDetailsOpen] = useState(false);
  const [isMoreToolsOpen, setIsMoreToolsOpen] = useState(false);
  const [publishDraft, setPublishDraft] = useState<PublishDraft>(() => buildDraftFromLane(null));
  const [selectedProductLaneKey, setSelectedProductLaneKey] = useState<string | null>(null);
  const [selectedUpload, setSelectedUpload] = useState<SelectedUpload | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const { contains } = useFilter({ sensitivity: 'base' });

  const packagesQuery = useQuery({
    queryKey: creatorPackagesQueryKey,
    queryFn: () => listCreatorPackages({ includeArchived: true }),
    enabled: canRunPanelQueries,
    retry: false,
  });

  const productsQuery = useQuery({
    queryKey: creatorBackstageProductsQueryKey,
    queryFn: () => listCreatorBackstageProducts(),
    enabled: canRunPanelQueries,
    retry: false,
  });

  const repoAccessQuery = useQuery({
    queryKey: creatorBackstageRepoAccessQueryKey,
    queryFn: requestBackstageRepoAccess,
    enabled: canRunPanelQueries,
    retry: false,
  });

  const productsLiveSyncQuery = useQuery({
    queryKey: creatorBackstageProductsLiveSyncQueryKey,
    queryFn: () => listCreatorBackstageProducts({ liveSync: true }),
    enabled: canRunPanelQueries && productsQuery.status === 'success',
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (!productsLiveSyncQuery.data) {
      return;
    }

    queryClient.setQueryData(creatorBackstageProductsQueryKey, productsLiveSyncQuery.data);
  }, [productsLiveSyncQuery.data, queryClient]);

  useEffect(() => {
    const candidateError =
      packagesQuery.error ??
      productsQuery.error ??
      productsLiveSyncQuery.error ??
      repoAccessQuery.error;
    if (isDashboardAuthError(candidateError)) {
      markSessionExpired();
    }
  }, [
    markSessionExpired,
    packagesQuery.error,
    productsQuery.error,
    productsLiveSyncQuery.error,
    repoAccessQuery.error,
  ]);

  const renameMutation = useMutation({
    mutationFn: renameCreatorPackage,
    onMutate: ({ packageId }) => setPendingSaveId(packageId),
    onSuccess: async () => {
      setEditingId(null);
      await queryClient.invalidateQueries({ queryKey: creatorPackagesQueryKey });
      toast.success('Package name saved');
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not save package name');
    },
    onSettled: () => setPendingSaveId(null),
  });

  const archiveMutation = useMutation({
    mutationFn: archiveCreatorPackage,
    onMutate: async ({ packageId }) => {
      setPendingArchiveId(packageId);
      await queryClient.cancelQueries({ queryKey: creatorPackagesQueryKey });
      const previousPackages =
        queryClient.getQueryData<CreatorPackageListResponse>(creatorPackagesQueryKey);
      queryClient.setQueryData<CreatorPackageListResponse | undefined>(
        creatorPackagesQueryKey,
        (current) =>
          updatePackageListCache(current, packageId, (pkg) => ({
            ...pkg,
            status: 'archived',
            archivedAt: Date.now(),
            canArchive: false,
            canRestore: true,
          }))
      );
      return { previousPackages };
    },
    onSuccess: () => {
      toast.success('Package hidden');
    },
    onError: (error, _variables, context) => {
      if (context?.previousPackages) {
        queryClient.setQueryData(creatorPackagesQueryKey, context.previousPackages);
      }
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : 'This package could not be hidden.';
      toast.error('Could not hide package', { description: errorMessage });
    },
    onSettled: () => setPendingArchiveId(null),
  });

  const restoreMutation = useMutation({
    mutationFn: restoreCreatorPackage,
    onMutate: async ({ packageId }) => {
      setPendingRestoreId(packageId);
      await queryClient.cancelQueries({ queryKey: creatorPackagesQueryKey });
      const previousPackages =
        queryClient.getQueryData<CreatorPackageListResponse>(creatorPackagesQueryKey);
      queryClient.setQueryData<CreatorPackageListResponse | undefined>(
        creatorPackagesQueryKey,
        (current) =>
          updatePackageListCache(current, packageId, (pkg) => ({
            ...pkg,
            status: 'active',
            archivedAt: undefined,
            canArchive: true,
            canRestore: false,
          }))
      );
      return { previousPackages };
    },
    onSuccess: () => {
      toast.success('Package restored');
    },
    onError: (error, _variables, context) => {
      if (context?.previousPackages) {
        queryClient.setQueryData(creatorPackagesQueryKey, context.previousPackages);
      }
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : 'This package could not be restored.';
      toast.error('Could not restore package', { description: errorMessage });
    },
    onSettled: () => setPendingRestoreId(null),
  });

  const archiveProductMutation = useMutation({
    mutationFn: async (lane: ProductLane) => {
      await Promise.all(
        lane.products
          .filter((product) => product.canArchive)
          .map((product) =>
            archiveCreatorBackstageProduct({ catalogProductId: product.catalogProductId })
          )
      );
      return lane;
    },
    onMutate: (lane) => setPendingProductArchiveKey(lane.laneKey),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: creatorBackstageProductsQueryKey });
      toast.success('Product link hidden');
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : 'This product link could not be hidden.';
      toast.error('Could not hide product link', { description: errorMessage });
    },
    onSettled: () => setPendingProductArchiveKey(null),
  });

  const restoreProductMutation = useMutation({
    mutationFn: async (lane: ProductLane) => {
      await Promise.all(
        lane.products
          .filter((product) => product.canRestore)
          .map((product) =>
            restoreCreatorBackstageProduct({ catalogProductId: product.catalogProductId })
          )
      );
      return lane;
    },
    onMutate: (lane) => setPendingProductRestoreKey(lane.laneKey),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: creatorBackstageProductsQueryKey });
      toast.success('Product link restored');
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : 'This product link could not be restored.';
      toast.error('Could not restore product link', { description: errorMessage });
    },
    onSettled: () => setPendingProductRestoreKey(null),
  });

  const archiveReleaseMutation = useMutation({
    mutationFn: ({
      packageId,
      deliveryPackageReleaseId,
    }: {
      packageId: string;
      deliveryPackageReleaseId: string;
    }) => archiveCreatorBackstageRelease({ packageId, deliveryPackageReleaseId }),
    onMutate: ({ deliveryPackageReleaseId }) => {
      setPendingReleaseArchiveId(deliveryPackageReleaseId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: creatorBackstageProductsQueryKey });
      toast.success('Old upload archived');
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : 'This upload could not be archived.';
      toast.error('Could not archive upload', { description: errorMessage });
    },
    onSettled: () => setPendingReleaseArchiveId(null),
  });

  const deleteReleaseMutation = useMutation({
    mutationFn: ({
      packageId,
      deliveryPackageReleaseId,
    }: {
      packageId: string;
      deliveryPackageReleaseId: string;
    }) => deleteCreatorBackstageRelease({ packageId, deliveryPackageReleaseId }),
    onMutate: ({ deliveryPackageReleaseId }) => {
      setPendingReleaseDeleteId(deliveryPackageReleaseId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: creatorBackstageProductsQueryKey });
      toast.success('Upload deleted');
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : 'This upload could not be deleted.';
      toast.error('Could not delete upload', { description: errorMessage });
    },
    onSettled: () => setPendingReleaseDeleteId(null),
  });

  const publishMutation = useMutation({
    mutationFn: async (draft: PublishDraft) => {
      if (!selectedUpload?.file) {
        throw new Error('Choose a package file before uploading.');
      }

      setSelectedUpload((current) =>
        current
          ? {
              ...current,
              status: 'uploading',
              errorMessage: undefined,
              progressLabel: 'Hashing',
              progressValue: 0,
            }
          : current
      );

      const packageId = draft.packageId.trim();
      const productLanes = buildProductLanes(productsQuery.data?.products ?? []);
      const selectedLane = productLanes.find((lane) => lane.laneKey === draft.laneKey);
      const linkedPackage = selectedLane?.primaryPackage ?? null;
      const resolvedDisplayName = draft.displayName.trim() || selectedLane?.title || packageId;
      const dependencyVersions = parseBackstageDependencyVersions(draft.dependenciesText);
      if (dependencyVersions.errorMessage) {
        throw new Error(dependencyVersions.errorMessage);
      }
      const selectedCatalogProductIds =
        draft.accessMode === 'tiers' && draft.catalogTierIds.length > 0
          ? Array.from(
              new Set(
                (selectedLane?.catalogTiers ?? [])
                  .filter((tier) => draft.catalogTierIds.includes(tier.catalogTierId))
                  .map((tier) => String(tier.catalogProductId))
              )
            )
          : draft.catalogProductIds.map((catalogProductId) => String(catalogProductId));
      const aliasIds = selectedLane
        ? resolveUniqueAliasIdsForCatalogProducts(selectedLane.products, selectedCatalogProductIds)
        : [];
      if (aliasIds.length > 1) {
        throw new Error(
          'This package is linked to storefront products with different install aliases. Review the product links before publishing another upload.'
        );
      }
      const upload = await uploadBackstageReleaseFileDirect({
        packageId,
        file: selectedUpload.file,
        onProgress: (progress) => {
          setSelectedUpload((current) =>
            current
              ? {
                  ...current,
                  progressLabel:
                    progress.stage === 'hashing'
                      ? 'Hashing'
                      : progress.stage === 'uploading'
                        ? 'Uploading'
                        : 'Finishing',
                  progressValue: progress.progress,
                }
              : current
          );
        },
      });
      const accessSelectors =
        draft.accessMode === 'tiers' && draft.catalogTierIds.length > 0
          ? draft.catalogTierIds.map((catalogTierId) => ({
              kind: 'catalogTier' as const,
              catalogTierId,
            }))
          : draft.catalogProductIds.map((catalogProductId) => ({
              kind: 'catalogProduct' as const,
              catalogProductId,
            }));

      const result = await publishBackstageRelease({
        packageId,
        body: {
          accessSelectors,
          cdngineSource: upload.cdngineSource,
          version: draft.version.trim(),
          channel: draft.channel.trim() || 'stable',
          packageName: packageId,
          displayName: resolvedDisplayName,
          description: draft.description.trim() || undefined,
          repositoryVisibility: draft.repositoryVisibility,
          defaultChannel: draft.channel.trim() || linkedPackage?.defaultChannel || 'stable',
          unityVersion: draft.unityVersion.trim() || undefined,
          dependencyVersions:
            dependencyVersions.dependencies.length > 0
              ? dependencyVersions.dependencies
              : undefined,
          deliveryName: upload.deliveryName ?? selectedUpload.file.name,
          sourceContentType:
            upload.sourceContentType ?? selectedUpload.file.type ?? 'application/octet-stream',
        },
      });

      return {
        packageId,
        result,
      };
    },
    onSuccess: async ({ packageId, result }) => {
      setSelectedUpload((current) =>
        current
          ? {
              ...current,
              status: 'complete',
              errorMessage: undefined,
              progressLabel: undefined,
              progressValue: 100,
            }
          : current
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: creatorPackagesQueryKey }),
        queryClient.invalidateQueries({ queryKey: creatorBackstageProductsQueryKey }),
      ]);
      toast.success('Package uploaded', {
        description: `${packageId}@${result.version} is now on ${result.channel}.`,
      });
      setIsPublishOpen(false);
      setPublishDraft(buildDraftFromLane(null));
      setSelectedUpload(null);
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : 'This package could not be uploaded.';
      setSelectedUpload((current) =>
        current
          ? {
              ...current,
              status: 'failed',
              errorMessage: message,
              progressLabel: undefined,
            }
          : current
      );
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not upload package', { description: message });
    },
  });

  const packages = useMemo(
    () =>
      [...(packagesQuery.data?.packages ?? [])].sort((a, b) =>
        (a.packageName ?? a.packageId).localeCompare(b.packageName ?? b.packageId)
      ),
    [packagesQuery.data?.packages]
  );
  const parsedDependencyVersions = useMemo(
    () => parseBackstageDependencyVersions(publishDraft.dependenciesText),
    [publishDraft.dependenciesText]
  );
  const selectedUploadNeedsServerMetadata = selectedUpload?.artifactKind === 'unitypackage';
  const products = useMemo(
    () =>
      [...(productsQuery.data?.products ?? [])].sort((a, b) =>
        (a.displayName ?? a.productId).localeCompare(b.displayName ?? b.productId)
      ),
    [productsQuery.data?.products]
  );
  const productLanes = useMemo(() => buildProductLanes(products), [products]);
  const activePackages = packages.filter((pkg) => pkg.status === 'active');
  const archivedPackages = packages.filter((pkg) => pkg.status === 'archived');
  const activeProductLanes = productLanes.filter((lane) => lane.status === 'active');
  const archivedProductLanes = productLanes.filter((lane) => lane.status === 'archived');
  const linkedLanes = activeProductLanes.filter((lane) => lane.packageLinks.length > 0);
  const normalizedSearch = normalizeComparableText(searchQuery);
  const filteredActivePackages = activePackages.filter((pkg) =>
    normalizeComparableText(`${pkg.packageName ?? ''} ${pkg.packageId}`).includes(normalizedSearch)
  );
  const filteredArchivedPackages = archivedPackages.filter((pkg) =>
    normalizeComparableText(`${pkg.packageName ?? ''} ${pkg.packageId}`).includes(normalizedSearch)
  );
  const filteredProductLanes = activeProductLanes;
  const filteredLinkedLanes = filteredProductLanes.filter((lane) => lane.packageLinks.length > 0);
  const filteredArchivedProductLanes = archivedProductLanes.filter((lane) =>
    normalizeComparableText(
      `${lane.title} ${lane.providerLabels.join(' ')} ${lane.packageLinks
        .map((packageLink) => packageLink.packageId)
        .join(' ')}`
    ).includes(normalizedSearch)
  );
  const selectedLane = productLanes.find((lane) => lane.laneKey === publishDraft.laneKey);
  const selectedProductLane =
    productLanes.find((lane) => lane.laneKey === selectedProductLaneKey) ?? null;
  const hasBlockingError =
    (packagesQuery.isError && !isDashboardAuthError(packagesQuery.error)) ||
    (productsQuery.isError && !isDashboardAuthError(productsQuery.error)) ||
    (repoAccessQuery.isError && !isDashboardAuthError(repoAccessQuery.error));
  const isWorkspaceLoading =
    ((packagesQuery.isLoading && !packagesQuery.data) ||
      (productsQuery.isLoading && !productsQuery.data) ||
      (repoAccessQuery.isLoading && !repoAccessQuery.data)) &&
    !hasBlockingError;
  const selectedLaneHasSinglePackage = Boolean(
    selectedLane?.primaryPackage && selectedLane.packageLinks.length === 1
  );
  const selectedLaneActiveTiers = selectedLane?.catalogTiers ?? [];
  const selectedLaneSupportsTierAccess = selectedLaneActiveTiers.length > 0;
  const selectedLaneAliasIds = selectedLane
    ? resolveUniqueAliasIdsForCatalogProducts(selectedLane.products, selectedLane.catalogProductIds)
    : [];
  const selectedLaneHasAliasConflict = selectedLaneAliasIds.length > 1;
  const installIdSuggestions = selectedLane
    ? selectedLane.packageLinks.length > 1
      ? selectedLane.packageLinks.slice(0, 4).map((packageLink) => ({
          packageId: packageLink.packageId,
          label: packageLink.displayName ?? packageLink.packageName ?? packageLink.packageId,
        }))
      : selectedLane.packageLinks.length === 0
        ? activePackages.slice(0, 4).map((pkg) => ({
            packageId: pkg.packageId,
            label: pkg.packageName ?? pkg.packageId,
          }))
        : []
    : [];

  function handleCopyId(packageId: string) {
    copyToClipboard(packageId).then((ok) => {
      if (ok) toast.success('Install ID copied');
      else toast.error('Could not copy to clipboard');
    });
  }

  function handleCopyValue(value: string, successLabel: string) {
    copyToClipboard(value).then((ok) => {
      if (ok) {
        toast.success(successLabel);
        return;
      }
      toast.error('Could not copy to clipboard');
    });
  }

  function getBuyerAccessUrl(lane: ProductLane): string | null {
    const catalogProductId = lane.catalogProductIds.find((value) => value.trim().length > 0);
    if (!catalogProductId) {
      return null;
    }

    const accessPath = buildBuyerProductAccessPath(catalogProductId);
    if (typeof window === 'undefined') {
      return accessPath;
    }
    return `${window.location.origin}${accessPath}`;
  }

  function openPublishSheet(lane?: ProductLane | null) {
    const defaultLane =
      lane ??
      (linkedLanes.length === 1
        ? linkedLanes[0]
        : activeProductLanes.length === 1
          ? activeProductLanes[0]
          : null);
    setPublishDraft(buildDraftFromLane(defaultLane));
    setSelectedUpload(null);
    setIsProductDetailsOpen(false);
    setIsPublishOpen(true);
  }

  function openProductDetails(lane: ProductLane) {
    setSelectedProductLaneKey(lane.laneKey);
    setIsProductDetailsOpen(true);
  }

  function handleLaneSelection(key: Key | null) {
    const laneKey = key ? String(key) : '';
    const lane = productLanes.find((candidate) => candidate.laneKey === laneKey) ?? null;
    setPublishDraft((current) => {
      const baseDraft = buildDraftFromLane(lane);
      return {
        ...baseDraft,
        description: current.description,
        dependenciesText: current.dependenciesText,
        laneKey,
        packageId: baseDraft.packageId || current.packageId,
        version: current.version,
      };
    });
  }

  function handleUploadSelection(file: File | null) {
    if (!file) {
      setSelectedUpload(null);
      return;
    }
    const artifactKind = getBackstageArtifactKind(file.name);
    if (!artifactKind) {
      toast.error('Choose a supported package file', {
        description: 'Backstage accepts .unitypackage files and legacy .zip bundles.',
      });
      return;
    }
    setSelectedUpload({
      artifactKind,
      contentType: getBackstageArtifactContentType(file, artifactKind),
      file,
      status: 'ready',
      progressLabel: undefined,
      progressValue: undefined,
    });
  }

  async function handleDrop(event: {
    items: Array<{ kind: string; getFile?: () => Promise<File> }>;
  }) {
    for (const item of event.items) {
      if (item.kind === 'file' && item.getFile) {
        handleUploadSelection(await item.getFile());
        return;
      }
    }
  }

  return (
    <section className={className}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="max-w-[64ch] space-y-1.5">
            <h2 className="text-foreground text-[2rem] font-semibold leading-tight">{title}</h2>
            <p className="pm-copy text-sm leading-6">{description}</p>
          </div>

          <div className="flex items-center gap-2 self-start md:self-auto">
            <Button
              variant="outline"
              className="pm-upload-button rounded-full px-4"
              onPress={() => openPublishSheet(null)}
            >
              <ArrowUpFromLine className="size-4" />
              Upload a package
            </Button>
          </div>
        </div>

        {hasBlockingError ? (
          <AccountInlineError message="Failed to load packages. Refresh and try again." />
        ) : null}

        {isWorkspaceLoading ? (
          <PackageRegistryWorkspaceSkeleton
            showHeader={false}
            className="w-full min-w-0"
            listRows={4}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <Card className="pm-card pm-primary-panel rounded-2xl shadow-none">
              <Card.Header className="flex flex-col gap-3 p-4 pb-2">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <StreamlineLinkChainIcon className="size-6" />
                    <p className="text-foreground text-lg font-semibold">
                      Products ready for an update
                    </p>
                  </div>
                  <p className="pm-copy max-w-[52ch] text-sm leading-6">
                    Choose a product below, upload the new file, and link buyers from the store page
                    to the matching YUCP access page.
                  </p>
                </div>
              </Card.Header>
              <Card.Content className="space-y-4 p-4 pt-0">
                <div className="pm-inline-note rounded-[18px] p-3">
                  <p className="text-foreground text-sm font-semibold">Customer setup steps</p>
                  <p className="pm-subtle-copy mt-1 text-sm leading-6">
                    Share your YUCP access page link in the store page, download notes, or
                    post-purchase message. Then tell buyers to sign in, verify their purchase, and
                    click Add to VCC.
                  </p>
                </div>
                {activeProductLanes.length === 0 && archivedProductLanes.length === 0 ? (
                  <EmptyState className="pm-empty-state rounded-2xl border border-dashed">
                    <EmptyState.Header>
                      <EmptyState.Media variant="icon">
                        <Store />
                      </EmptyState.Media>
                      <EmptyState.Title>No catalog products yet</EmptyState.Title>
                      <EmptyState.Description>
                        Sync or create creator products first. Once a product exists, you can attach
                        a package upload to it here.
                      </EmptyState.Description>
                    </EmptyState.Header>
                  </EmptyState>
                ) : (
                  <div className="space-y-3">
                    {filteredLinkedLanes.map((lane) => (
                      <ProductLaneCard
                        key={lane.laneKey}
                        buyerAccessUrl={getBuyerAccessUrl(lane)}
                        lane={lane}
                        isRestoring={false}
                        onCopyBuyerAccess={(value) =>
                          handleCopyValue(value, 'Store-page link copied')
                        }
                        onOpenDetails={openProductDetails}
                        onPublish={openPublishSheet}
                        onRestore={() => {}}
                      />
                    ))}
                    {filteredLinkedLanes.length === 0 ? (
                      <p className="pm-muted-panel pm-subtle-copy rounded-2xl p-4 text-sm">
                        Nothing is ready yet. Use Upload a package to add the first product.
                      </p>
                    ) : null}
                  </div>
                )}
              </Card.Content>
            </Card>

            <section className="pm-management-details rounded-2xl p-4">
              <button
                type="button"
                className="text-foreground flex w-full cursor-pointer items-center justify-between gap-3 text-left text-sm font-medium"
                aria-expanded={isMoreToolsOpen}
                onClick={() => setIsMoreToolsOpen((current) => !current)}
              >
                <span>More tools</span>
              </button>
              {isMoreToolsOpen ? (
                <div className="mt-4 space-y-4">
                  <p className="pm-subtle-copy max-w-[58ch] text-sm leading-6">
                    Keep customer-facing distribution on the YUCP access page. Open these sections
                    only for install ID cleanup, hidden links, or creator-side testing and support.
                  </p>

                  <section className="pm-tool-section space-y-4">
                    <div className="space-y-1">
                      <p className="text-foreground text-sm font-semibold">
                        Testing and support repo tools
                      </p>
                      <p className="pm-subtle-copy max-w-[58ch] text-sm leading-6">
                        Use these only after your store page points buyers to the YUCP access page.
                        These open the repo directly for your own QA or guided support, not for
                        customer-facing distribution.
                      </p>
                      {repoAccessQuery.data?.creatorRepoRef ? (
                        <p className="pm-subtle-copy break-all font-mono text-xs">
                          {repoAccessQuery.data.creatorName ??
                            repoAccessQuery.data.repositoryName ??
                            'Backstage repo'}
                          {' · '}
                          {repoAccessQuery.data.creatorRepoRef}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {repoAccessQuery.data?.addRepoUrl ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onPress={() => {
                            window.location.href = repoAccessQuery.data?.addRepoUrl ?? '';
                          }}
                        >
                          <ExternalLink className="size-4" />
                          Open test repo in VCC
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onPress={() =>
                          repoAccessQuery.data?.addRepoUrl
                            ? handleCopyValue(
                                repoAccessQuery.data.addRepoUrl,
                                'Test VCC link copied'
                              )
                            : Promise.resolve(false)
                        }
                      >
                        <Copy className="size-4" />
                        Copy test VCC link
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onPress={() =>
                          repoAccessQuery.data?.repositoryUrl
                            ? handleCopyValue(
                                repoAccessQuery.data.repositoryUrl,
                                'Raw repo URL copied'
                              )
                            : Promise.resolve(false)
                        }
                      >
                        <Copy className="size-4" />
                        Copy raw repo URL
                      </Button>
                    </div>
                  </section>

                  <section className="pm-tool-section space-y-4">
                    <div className="space-y-1">
                      <p className="text-foreground text-sm font-semibold">Manage install IDs</p>
                      <p className="pm-subtle-copy max-w-[58ch] text-sm leading-6">
                        These are the package IDs buyers install from your repo. Open this to
                        rename, copy, or hide old ones.
                      </p>
                    </div>
                    {packages.length === 0 ? (
                      <EmptyState className="pm-empty-state rounded-2xl border border-dashed">
                        <EmptyState.Header>
                          <EmptyState.Media variant="icon">
                            <FolderUp />
                          </EmptyState.Media>
                          <EmptyState.Title>No install IDs yet</EmptyState.Title>
                          <EmptyState.Description>
                            Upload the first package to create one.
                          </EmptyState.Description>
                        </EmptyState.Header>
                      </EmptyState>
                    ) : (
                      <>
                        <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[320px] sm:flex-row">
                          <div className="relative min-w-0 flex-1">
                            <Search className="pm-subtle-copy pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                            <YucpInput
                              aria-label="Search install IDs"
                              className="w-full pl-9"
                              placeholder="Find an install ID"
                              value={searchQuery}
                              onValueChange={setSearchQuery}
                            />
                          </div>
                        </div>
                        <p className="pm-subtle-copy text-sm">
                          {activePackages.length} active · {archivedPackages.length} hidden
                        </p>
                        {filteredActivePackages.length > 0 ? (
                          <div className="space-y-3">
                            {filteredActivePackages.map((pkg) => (
                              <PackageRegistryItem
                                key={pkg.packageId}
                                pkg={pkg}
                                isEditing={editingId === pkg.packageId}
                                editName={
                                  editingId === pkg.packageId
                                    ? editingName
                                    : (pkg.packageName ?? '')
                                }
                                isSaving={
                                  pendingSaveId === pkg.packageId && renameMutation.isPending
                                }
                                isArchiving={
                                  pendingArchiveId === pkg.packageId && archiveMutation.isPending
                                }
                                isRestoring={false}
                                onEditStart={() => {
                                  setEditingId(pkg.packageId);
                                  setEditingName(pkg.packageName ?? '');
                                }}
                                onEditCancel={() => setEditingId(null)}
                                onEditChange={setEditingName}
                                onSave={() =>
                                  renameMutation.mutate({
                                    packageId: pkg.packageId,
                                    packageName: editingName.trim(),
                                  })
                                }
                                onArchive={() =>
                                  archiveMutation.mutate({ packageId: pkg.packageId })
                                }
                                onRestore={() => {}}
                                onCopyId={() => handleCopyId(pkg.packageId)}
                              />
                            ))}
                          </div>
                        ) : (
                          <p className="pm-muted-panel pm-subtle-copy rounded-2xl p-4 text-sm">
                            No install IDs match that search.
                          </p>
                        )}

                        {archivedPackages.length > 0 ? (
                          <details className="pm-muted-panel rounded-2xl p-4">
                            <summary className="text-foreground flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium">
                              <span className="flex items-center gap-2">
                                <Archive className="size-4" />
                                Hidden install IDs
                              </span>
                              <Chip size="sm" variant="soft">
                                {archivedPackages.length}
                              </Chip>
                            </summary>
                            <div className="mt-4 space-y-3">
                              {filteredArchivedPackages.length > 0 ? (
                                filteredArchivedPackages.map((pkg) => (
                                  <PackageRegistryItem
                                    key={pkg.packageId}
                                    pkg={pkg}
                                    isEditing={false}
                                    editName={pkg.packageName ?? ''}
                                    isSaving={false}
                                    isArchiving={false}
                                    isRestoring={
                                      pendingRestoreId === pkg.packageId &&
                                      restoreMutation.isPending
                                    }
                                    onEditStart={() => {}}
                                    onEditCancel={() => {}}
                                    onEditChange={() => {}}
                                    onSave={() => {}}
                                    onArchive={() => {}}
                                    onRestore={() =>
                                      restoreMutation.mutate({ packageId: pkg.packageId })
                                    }
                                    onCopyId={() => handleCopyId(pkg.packageId)}
                                  />
                                ))
                              ) : (
                                <p className="pm-subtle-copy text-sm">
                                  No hidden install IDs match that search.
                                </p>
                              )}
                            </div>
                          </details>
                        ) : null}
                      </>
                    )}
                  </section>

                  {archivedProductLanes.length > 0 ? (
                    <section className="pm-tool-section space-y-3">
                      <div className="space-y-1">
                        <p className="text-foreground text-sm font-semibold">
                          Hidden product links
                        </p>
                        <p className="pm-subtle-copy text-sm">
                          Restore these when you want the product back in your upload list.
                        </p>
                      </div>
                      <div className="space-y-3">
                        {filteredArchivedProductLanes.length > 0 ? (
                          filteredArchivedProductLanes.map((lane) => (
                            <ProductLaneCard
                              key={lane.laneKey}
                              lane={lane}
                              isRestoring={
                                pendingProductRestoreKey === lane.laneKey &&
                                restoreProductMutation.isPending
                              }
                              onOpenDetails={openProductDetails}
                              onPublish={openPublishSheet}
                              onRestore={(targetLane) => restoreProductMutation.mutate(targetLane)}
                            />
                          ))
                        ) : (
                          <p className="pm-subtle-copy text-sm">
                            No hidden product links match that search.
                          </p>
                        )}
                      </div>
                    </section>
                  ) : null}
                </div>
              ) : null}
            </section>
          </div>
        )}
      </div>

      <ProductLaneDetailsSheet
        key={selectedProductLane?.laneKey ?? 'no-lane-selected'}
        buyerAccessUrl={selectedProductLane ? getBuyerAccessUrl(selectedProductLane) : null}
        isArchiving={
          selectedProductLane
            ? pendingProductArchiveKey === selectedProductLane.laneKey &&
              archiveProductMutation.isPending
            : false
        }
        archivingReleaseId={pendingReleaseArchiveId}
        deletingReleaseId={pendingReleaseDeleteId}
        isRestoring={
          selectedProductLane
            ? pendingProductRestoreKey === selectedProductLane.laneKey &&
              restoreProductMutation.isPending
            : false
        }
        lane={selectedProductLane}
        isOpen={isProductDetailsOpen}
        onArchive={(lane) => archiveProductMutation.mutate(lane)}
        onArchiveRelease={(packageId, release) =>
          archiveReleaseMutation.mutate({
            packageId,
            deliveryPackageReleaseId: release.deliveryPackageReleaseId,
          })
        }
        onCopyBuyerAccess={(value) => handleCopyValue(value, 'Store-page link copied')}
        onCopyPackageId={(packageId) =>
          handleCopyValue(packageId, `Copied install ID ${packageId}`)
        }
        onDeleteRelease={(packageId, release) =>
          deleteReleaseMutation.mutate({
            packageId,
            deliveryPackageReleaseId: release.deliveryPackageReleaseId,
          })
        }
        onOpenChange={setIsProductDetailsOpen}
        onPublish={openPublishSheet}
        onRestore={(lane) => restoreProductMutation.mutate(lane)}
      />

      <Sheet isOpen={isPublishOpen} onOpenChange={setIsPublishOpen}>
        <Sheet.Backdrop variant="blur">
          <Sheet.Content className="pm-sheet-content mx-auto max-h-[94vh] max-w-[680px]">
            <Sheet.Dialog className="pm-sheet-dialog">
              <Sheet.Handle />
              <Sheet.CloseTrigger />
              <Sheet.Header className="pm-sheet-header">
                <Sheet.Heading>Upload a package</Sheet.Heading>
                <p className="pm-copy text-sm leading-6">
                  Pick the product, add the file, and publish it.
                </p>
              </Sheet.Header>
              <Sheet.Body className="space-y-5">
                <div className="pm-sheet-section space-y-4 rounded-[20px] p-4">
                  <div className="space-y-1">
                    <p className="text-foreground text-sm font-semibold">Product</p>
                    <p className="pm-subtle-copy text-sm">
                      Choose what this file belongs to. If it is new here, this upload adds it.
                    </p>
                  </div>
                  <Autocomplete
                    aria-label="Product"
                    className="w-full"
                    placeholder="Choose a product"
                    selectionMode="single"
                    value={publishDraft.laneKey || null}
                    onChange={handleLaneSelection}
                    onClear={() => handleLaneSelection(null)}
                  >
                    <Autocomplete.Trigger>
                      <Autocomplete.Value />
                      <Autocomplete.ClearButton />
                      <Autocomplete.Indicator />
                    </Autocomplete.Trigger>
                    <Autocomplete.Popover>
                      <Autocomplete.Filter filter={contains}>
                        <SearchField autoFocus name="product-search" variant="secondary">
                          <SearchField.Group>
                            <SearchField.SearchIcon />
                            <SearchField.Input
                              aria-label="Search products"
                              placeholder="Search products..."
                            />
                            <SearchField.ClearButton />
                          </SearchField.Group>
                        </SearchField>
                        <ListBox
                          renderEmptyState={() => (
                            <div className="pm-subtle-copy px-3 py-2 text-sm">
                              No products match that search.
                            </div>
                          )}
                        >
                          {activeProductLanes.map((lane) => (
                            <ListBox.Item
                              key={lane.laneKey}
                              id={lane.laneKey}
                              textValue={getLaneSearchText(lane)}
                            >
                              <div className="flex flex-col">
                                <span>{lane.title}</span>
                                <span className="pm-subtle-copy text-xs">
                                  {lane.products.length} storefront
                                  {lane.products.length === 1 ? '' : 's'} ·{' '}
                                  {lane.providerLabels.join(', ')}
                                  {' · '}
                                  {lane.packageLinks.length > 0
                                    ? 'Ready for updates'
                                    : 'Needs first upload'}
                                </span>
                              </div>
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Autocomplete.Filter>
                    </Autocomplete.Popover>
                  </Autocomplete>
                  {selectedLane ? (
                    <div className="pm-inline-note rounded-[18px] p-3">
                      {selectedLaneHasAliasConflict ? (
                        <p className="text-danger text-sm leading-6">
                          This package lane spans storefront products with different install
                          aliases. Review the linked products before publishing another upload.
                        </p>
                      ) : (
                        <p className="pm-subtle-copy text-sm leading-6">
                          {selectedLaneHasSinglePackage
                            ? 'This keeps the same install ID buyers already use.'
                            : selectedLane.packageLinks.length > 1
                              ? 'This product has more than one install ID. Pick the one you want below.'
                              : 'This product needs its first install ID.'}
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>

                {selectedLane ? (
                  <>
                    {selectedLaneSupportsTierAccess ? (
                      <div className="pm-sheet-section space-y-4 rounded-[20px] p-4">
                        <div className="space-y-1">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-foreground text-sm font-semibold">Access</p>
                            <Chip size="sm" variant="soft">
                              {selectedLaneActiveTiers.length} synced tier
                              {selectedLaneActiveTiers.length === 1 ? '' : 's'}
                            </Chip>
                          </div>
                          <p className="pm-subtle-copy text-sm">
                            Release to the whole subscription product, or narrow installs to the
                            synced tiers that should keep access.
                          </p>
                        </div>

                        <RadioGroup
                          aria-label="Package access mode"
                          className="space-y-3"
                          name="package-access-mode"
                          value={publishDraft.accessMode}
                          onChange={(value) =>
                            setPublishDraft((current) => ({
                              ...current,
                              accessMode: value === 'tiers' ? 'tiers' : 'product',
                              catalogTierIds: value === 'tiers' ? current.catalogTierIds : [],
                            }))
                          }
                        >
                          <Radio value="product" className="pm-inline-note rounded-[18px] p-3">
                            <Radio.Control>
                              <Radio.Indicator />
                            </Radio.Control>
                            <Radio.Content className="space-y-1">
                              <Label className="text-foreground block text-sm font-semibold">
                                Whole subscription product
                              </Label>
                              <Description className="pm-subtle-copy block text-sm">
                                Anyone entitled to this product or campaign can install the package.
                              </Description>
                            </Radio.Content>
                          </Radio>

                          <Radio value="tiers" className="pm-inline-note rounded-[18px] p-3">
                            <Radio.Control>
                              <Radio.Indicator />
                            </Radio.Control>
                            <Radio.Content className="space-y-1">
                              <Label className="text-foreground block text-sm font-semibold">
                                Specific subscription tiers
                              </Label>
                              <Description className="pm-subtle-copy block text-sm">
                                Only buyers with one of the selected active tiers can install this
                                package.
                              </Description>
                            </Radio.Content>
                          </Radio>
                        </RadioGroup>

                        {publishDraft.accessMode === 'tiers' ? (
                          <div className="space-y-3">
                            <div className="space-y-1">
                              <p className="pm-field-label">Allowed tiers</p>
                              <p className="pm-subtle-copy text-sm">
                                Pick every tier that should continue to unlock this install ID.
                              </p>
                            </div>
                            <CheckboxGroup
                              aria-label="Allowed subscription tiers"
                              className="space-y-2"
                              value={publishDraft.catalogTierIds}
                              onChange={(value) =>
                                setPublishDraft((current) => ({
                                  ...current,
                                  catalogTierIds: value,
                                }))
                              }
                            >
                              {selectedLaneActiveTiers.map((tier) => {
                                const tierPrice = formatTierPrice(tier);
                                return (
                                  <Checkbox
                                    key={tier.catalogTierId}
                                    value={tier.catalogTierId}
                                    className="pm-inline-note rounded-[18px] p-3"
                                  >
                                    <Checkbox.Control>
                                      <Checkbox.Indicator />
                                    </Checkbox.Control>
                                    <Checkbox.Content className="space-y-1">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <Label className="text-foreground text-sm font-semibold">
                                          {tier.displayName}
                                        </Label>
                                        {tierPrice ? (
                                          <Chip size="sm" variant="soft">
                                            {tierPrice}
                                          </Chip>
                                        ) : null}
                                      </div>
                                      {tier.description ? (
                                        <Description className="pm-subtle-copy block text-sm">
                                          {tier.description}
                                        </Description>
                                      ) : null}
                                    </Checkbox.Content>
                                  </Checkbox>
                                );
                              })}
                            </CheckboxGroup>
                            <p className="pm-subtle-copy text-xs">
                              Select at least one tier to keep this package subscription-gated.
                            </p>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="pm-sheet-section space-y-4 rounded-[20px] p-4">
                      <div className="pm-form-grid">
                        <div className="pm-field-stack">
                          <p className="pm-field-label">
                            {selectedLaneHasSinglePackage ? 'Install ID' : 'Install ID to use'}
                          </p>
                          {selectedLaneHasSinglePackage && selectedLane.primaryPackage ? (
                            <div className="pm-static-field" id="package-release-package-id">
                              <p className="text-foreground break-all font-mono text-sm">
                                {selectedLane.primaryPackage.packageId}
                              </p>
                              <p className="pm-subtle-copy text-xs">
                                Buyers keep using this same install ID.
                              </p>
                            </div>
                          ) : (
                            <YucpInput
                              id="package-release-package-id"
                              aria-label="Install ID"
                              placeholder="com.yourname.product"
                              value={publishDraft.packageId}
                              onValueChange={(value) =>
                                setPublishDraft((current) => ({
                                  ...current,
                                  packageId: value,
                                }))
                              }
                            />
                          )}
                        </div>
                        <div className="pm-field-stack">
                          <p className="pm-field-label">Version</p>
                          <YucpInput
                            id="package-release-version"
                            aria-label="Version"
                            placeholder="1.0.0"
                            value={publishDraft.version}
                            onValueChange={(value) =>
                              setPublishDraft((current) => ({
                                ...current,
                                version: value,
                              }))
                            }
                          />
                        </div>
                      </div>

                      {!selectedLaneHasSinglePackage && installIdSuggestions.length > 0 ? (
                        <div className="pm-inline-note rounded-[18px] p-3">
                          <p className="text-foreground text-sm font-semibold">
                            Already have an install ID?
                          </p>
                          <p className="pm-subtle-copy mt-1 text-sm">
                            Pick one below if buyers should keep using an existing install ID.
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {installIdSuggestions.map((suggestion) => (
                              <Button
                                key={suggestion.packageId}
                                size="sm"
                                variant="ghost"
                                onPress={() =>
                                  setPublishDraft((current) => ({
                                    ...current,
                                    packageId: suggestion.packageId,
                                  }))
                                }
                              >
                                <Package2 className="size-4" />
                                {suggestion.label}
                              </Button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <div className="pm-sheet-section space-y-4 rounded-[20px] p-4">
                      <div className="pm-field-stack">
                        <p className="pm-field-label">Release file</p>
                        <p className="pm-subtle-copy text-sm">
                          Use a `.unitypackage`, or a legacy `.zip` if you are moving older uploads.
                        </p>
                        <DropZone className="pm-upload-dropzone w-full">
                          <DropZone.Area onDrop={handleDrop as never}>
                            <DropZone.Icon>
                              <StreamlineShippingBoxIcon className="size-8" />
                            </DropZone.Icon>
                            <DropZone.Label>Drop the update file here</DropZone.Label>
                            <DropZone.Description>
                              Or choose it from your computer.
                            </DropZone.Description>
                            <DropZone.Trigger isDisabled={publishMutation.isPending}>
                              Choose update file
                            </DropZone.Trigger>
                          </DropZone.Area>
                          <DropZone.Input
                            accept={UNITYPACKAGE_ACCEPT_VALUE}
                            aria-label="Choose update file"
                            onSelect={(fileList) => handleUploadSelection(fileList.item(0))}
                          />

                          {selectedUpload ? (
                            <DropZone.FileList>
                              <DropZone.FileItem status={mapUploadStatus(selectedUpload.status)}>
                                <DropZone.FileFormatIcon
                                  color={
                                    selectedUpload.artifactKind === 'unitypackage'
                                      ? 'blue'
                                      : 'orange'
                                  }
                                  format={
                                    selectedUpload.artifactKind === 'unitypackage' ? 'UNITY' : 'ZIP'
                                  }
                                />
                                <DropZone.FileInfo>
                                  <DropZone.FileName>{selectedUpload.file.name}</DropZone.FileName>
                                  <DropZone.FileMeta>
                                    {formatFileSize(selectedUpload.file.size)}
                                    {' | '}
                                    {selectedUpload.artifactKind === 'unitypackage'
                                      ? 'Unity package'
                                      : 'Legacy ZIP'}
                                    {selectedUpload.status === 'ready'
                                      ? ' | Ready to publish'
                                      : null}
                                    {selectedUpload.status === 'uploading'
                                      ? ` | ${selectedUpload.progressLabel ?? 'Uploading'}…`
                                      : null}
                                    {selectedUpload.status === 'complete' ? ' | Uploaded' : null}
                                    {selectedUpload.status === 'failed' ? ' | Upload failed' : null}
                                  </DropZone.FileMeta>
                                  {selectedUpload.status === 'uploading' ? (
                                    <DropZone.FileProgress
                                      value={selectedUpload.progressValue ?? 0}
                                    >
                                      <DropZone.FileProgressTrack>
                                        <DropZone.FileProgressFill />
                                      </DropZone.FileProgressTrack>
                                    </DropZone.FileProgress>
                                  ) : null}
                                  {selectedUpload.errorMessage ? (
                                    <DropZone.FileMeta>
                                      {selectedUpload.errorMessage}
                                    </DropZone.FileMeta>
                                  ) : null}
                                </DropZone.FileInfo>
                                <DropZone.FileRemoveTrigger
                                  aria-label={`Remove ${selectedUpload.file.name}`}
                                  onPress={() => setSelectedUpload(null)}
                                />
                              </DropZone.FileItem>
                            </DropZone.FileList>
                          ) : null}
                        </DropZone>
                      </div>

                      <div className="pm-muted-panel space-y-4 rounded-2xl p-4">
                        <div className="space-y-1">
                          <p className="text-foreground text-sm font-semibold">Package metadata</p>
                          <p className="pm-subtle-copy text-sm">
                            {selectedUploadNeedsServerMetadata
                              ? 'YUCP will generate the VPM manifest on the server from these fields before buyers install this .unitypackage.'
                              : 'Optional metadata for the generated VPM release record.'}
                          </p>
                        </div>
                        <div className="pm-form-grid">
                          <div className="pm-field-stack">
                            <p className="pm-field-label">Display name</p>
                            <YucpInput
                              aria-label="Display name"
                              placeholder="Buyer-facing package name"
                              value={publishDraft.displayName}
                              onValueChange={(value) =>
                                setPublishDraft((current) => ({
                                  ...current,
                                  displayName: value,
                                }))
                              }
                            />
                          </div>
                          <div className="pm-field-stack">
                            <p className="pm-field-label">Unity version</p>
                            <YucpInput
                              aria-label="Unity version"
                              placeholder="Optional"
                              value={publishDraft.unityVersion}
                              onValueChange={(value) =>
                                setPublishDraft((current) => ({
                                  ...current,
                                  unityVersion: value,
                                }))
                              }
                            />
                          </div>
                        </div>
                        <div className="pm-field-stack">
                          <p className="pm-field-label">Package description</p>
                          <TextArea
                            aria-label="Package description"
                            placeholder="What should buyers see in the generated package metadata?"
                            variant="secondary"
                            value={publishDraft.description}
                            onChange={(event) =>
                              setPublishDraft((current) => ({
                                ...current,
                                description: event.target.value,
                              }))
                            }
                          />
                        </div>
                        <div className="pm-field-stack">
                          <p className="pm-field-label">Dependencies</p>
                          <TextArea
                            aria-label="Dependencies"
                            placeholder={'com.vrchat.base@3.7.0\ncom.yucp.importer=1.4.0'}
                            variant="secondary"
                            value={publishDraft.dependenciesText}
                            onChange={(event) =>
                              setPublishDraft((current) => ({
                                ...current,
                                dependenciesText: event.target.value,
                              }))
                            }
                          />
                          <p className="pm-subtle-copy text-xs">
                            One dependency per line with <code>packageId@version</code> or{' '}
                            <code>packageId=version</code>.
                          </p>
                          {parsedDependencyVersions.errorMessage ? (
                            <p className="text-danger text-xs">
                              {parsedDependencyVersions.errorMessage}
                            </p>
                          ) : null}
                        </div>
                      </div>

                      <details className="pm-muted-panel rounded-2xl p-4">
                        <summary className="text-foreground cursor-pointer list-none text-sm font-medium">
                          More options
                        </summary>
                        <div className="mt-4 space-y-4">
                          <div className="pm-form-grid">
                            <div className="pm-field-stack">
                              <p className="pm-field-label">Visibility</p>
                              <Select
                                aria-label="Repository visibility"
                                className="w-full"
                                selectedKey={publishDraft.repositoryVisibility}
                                onSelectionChange={(key) =>
                                  setPublishDraft((current) => ({
                                    ...current,
                                    repositoryVisibility: String(key ?? 'listed') as
                                      | 'hidden'
                                      | 'listed',
                                  }))
                                }
                              >
                                <Select.Trigger>
                                  <Select.Value />
                                  <Select.Indicator />
                                </Select.Trigger>
                                <Select.Popover>
                                  <ListBox>
                                    <ListBox.Item id="listed" textValue="Listed">
                                      Visible in VCC now
                                      <ListBox.ItemIndicator />
                                    </ListBox.Item>
                                    <ListBox.Item id="hidden" textValue="Hidden">
                                      Keep hidden for now
                                      <ListBox.ItemIndicator />
                                    </ListBox.Item>
                                  </ListBox>
                                </Select.Popover>
                              </Select>
                            </div>
                          </div>
                          <div className="pm-form-grid">
                            <div className="pm-field-stack">
                              <p className="pm-field-label">Channel</p>
                              <YucpInput
                                aria-label="Channel"
                                placeholder="stable"
                                value={publishDraft.channel}
                                onValueChange={(value) =>
                                  setPublishDraft((current) => ({
                                    ...current,
                                    channel: value,
                                  }))
                                }
                              />
                            </div>
                          </div>
                        </div>
                      </details>
                    </div>
                  </>
                ) : (
                  <div className="pm-inline-note rounded-[18px] p-4">
                    <p className="text-foreground text-sm font-semibold">Pick a product first</p>
                    <p className="pm-subtle-copy mt-1 text-sm leading-6">
                      After that, the install ID, version, and upload box will show up here.
                    </p>
                  </div>
                )}
              </Sheet.Body>
              <Sheet.Footer className="pm-sheet-footer">
                <Sheet.Close>
                  <Button variant="secondary">Cancel</Button>
                </Sheet.Close>
                <YucpButton
                  isLoading={publishMutation.isPending}
                  isDisabled={
                    publishMutation.isPending ||
                    selectedLaneHasAliasConflict ||
                    publishDraft.catalogProductIds.length === 0 ||
                    (publishDraft.accessMode === 'tiers' &&
                      publishDraft.catalogTierIds.length === 0) ||
                    !publishDraft.packageId.trim() ||
                    !publishDraft.version.trim() ||
                    !selectedUpload?.file ||
                    Boolean(parsedDependencyVersions.errorMessage)
                  }
                  onPress={() => publishMutation.mutate(publishDraft)}
                >
                  <ArrowUpFromLine className="size-4" />
                  Upload package
                </YucpButton>
              </Sheet.Footer>
            </Sheet.Dialog>
          </Sheet.Content>
        </Sheet.Backdrop>
      </Sheet>
    </section>
  );
}
