import {
  Alert,
  Autocomplete,
  Button,
  Card,
  Chip,
  Label,
  ListBox,
  ProgressBar,
  SearchField,
  Select,
  Skeleton,
  useFilter,
} from '@heroui/react';
import { DropZone } from '@heroui-pro/react/drop-zone';
import { EmptyState } from '@heroui-pro/react/empty-state';
import { ItemCard } from '@heroui-pro/react/item-card';
import { ItemCardGroup } from '@heroui-pro/react/item-card-group';
import { ListView } from '@heroui-pro/react/list-view';
import { Segment } from '@heroui-pro/react/segment';
import { Sheet } from '@heroui-pro/react/sheet';
import { Stepper } from '@heroui-pro/react/stepper';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { isStrictSemanticVersion } from '@yucp/shared/semanticVersion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DialogContext, Heading } from 'react-aria-components';
import { AccountInlineError } from '@/components/account/AccountPage';
import { PackageRegistryWorkspaceSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { HoldConfirmButton } from '@/components/ui/HoldConfirmButton';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { YucpInput } from '@/components/ui/YucpInput';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import { getAccountProviderIconPath } from '@/lib/account';
import {
  archiveCreatorPackageEdition,
  bindCreatorPackageStorefront,
  type CreatorPackageEditionSummary,
  type CreatorPackagePickerProduct,
  type CreatorPackageProductSummary,
  type CreatorPackageVersionListPage,
  type CreatorPackageVersionStatus,
  createCreatorPackageVccLink,
  deleteCreatorPackageVersion,
  downloadCreatorPackageBootstrap,
  getCreatorPackageEditionOptions,
  getCreatorPackageProduct,
  getCreatorPackageVccLink,
  getCreatorPackageVersionStatus,
  listCreatorPackagePickerProducts,
  listCreatorPackageProducts,
  listCreatorPackageVersions,
  revokeCreatorPackageVccLink,
  saveCreatorPackageEdition,
  unbindCreatorPackageStorefront,
  updateCreatorPackagePresentation,
  updateCreatorPackagePublicLink,
} from '@/lib/packages';
import { buildBuyerProductAccessPath } from '@/lib/productAccess';
import { uploadPackageFile } from '@/lib/upload';
import { copyToClipboard } from '@/lib/utils';

interface PackageRegistryPanelProps {
  className?: string;
}

type SelectedUpload = {
  file?: File;
  fileName: string;
  fileSize: number;
  progress: number;
  status:
    | 'ready'
    | 'uploading'
    | 'queued'
    | 'preparing'
    | 'publishing'
    | 'recovering'
    | 'complete'
    | 'failed';
  catalogProductId?: string;
  editionId?: string;
  errorMessage?: string;
  estimatedStartAt?: string | null;
  packageId?: string;
  queuePosition?: number | null;
  versionId?: string;
};

const creatorProductsQueryKey = ['creator-package-products'] as const;
const creatorProductPickerQueryKey = ['creator-package-product-picker'] as const;
const ACCEPTED_UPLOAD_LANE_STORAGE_KEY = 'yucp.package-upload.accepted-lane.v1';
const PACKAGE_FILE_EXTENSIONS = ['.unitypackage', '.zip', '.spp'] as const;
const PACKAGE_FILE_ACCEPT = `${PACKAGE_FILE_EXTENSIONS.join(',')},application/octet-stream,application/zip`;

type PersistedAcceptedUploadLane = {
  acceptedAt?: number;
  catalogProductId: string;
  editionId: string;
  fileName: string;
  fileSize: number;
  packageId: string;
  progress: number;
  status: Extract<
    SelectedUpload['status'],
    'uploading' | 'queued' | 'preparing' | 'publishing' | 'recovering'
  >;
  version: string;
  versionId: string;
};

const ACCEPTED_UPLOAD_LANE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function uploadLaneStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readAcceptedUploadLane(): PersistedAcceptedUploadLane | null {
  const storage = uploadLaneStorage();
  if (!storage) return null;
  try {
    const parsed = JSON.parse(
      storage.getItem(ACCEPTED_UPLOAD_LANE_STORAGE_KEY) ?? 'null'
    ) as Partial<PersistedAcceptedUploadLane> | null;
    if (
      !parsed ||
      typeof parsed.catalogProductId !== 'string' ||
      typeof parsed.editionId !== 'string' ||
      typeof parsed.fileName !== 'string' ||
      typeof parsed.fileSize !== 'number' ||
      typeof parsed.packageId !== 'string' ||
      typeof parsed.progress !== 'number' ||
      !['uploading', 'queued', 'preparing', 'publishing', 'recovering'].includes(
        parsed.status ?? ''
      ) ||
      typeof parsed.version !== 'string' ||
      typeof parsed.versionId !== 'string'
    ) {
      storage.removeItem(ACCEPTED_UPLOAD_LANE_STORAGE_KEY);
      return null;
    }
    if (
      typeof parsed.acceptedAt === 'number' &&
      Date.now() - parsed.acceptedAt > ACCEPTED_UPLOAD_LANE_MAX_AGE_MS
    ) {
      storage.removeItem(ACCEPTED_UPLOAD_LANE_STORAGE_KEY);
      return null;
    }
    return parsed as PersistedAcceptedUploadLane;
  } catch {
    storage.removeItem(ACCEPTED_UPLOAD_LANE_STORAGE_KEY);
    return null;
  }
}

function isSupportedPackageFileName(fileName: string): boolean {
  const normalizedName = fileName.toLowerCase();
  return PACKAGE_FILE_EXTENSIONS.some((extension) => normalizedName.endsWith(extension));
}

function isPrereleaseSemanticVersion(version: string): boolean {
  return version.split('+', 1)[0]?.includes('-') ?? false;
}

function getPackageFilePresentation(fileName: string) {
  const normalizedName = fileName.toLowerCase();
  if (normalizedName.endsWith('.zip')) return { color: 'orange' as const, format: 'ZIP' };
  if (normalizedName.endsWith('.spp')) return { color: 'blue' as const, format: 'SPP' };
  return { color: 'blue' as const, format: 'UNITY' };
}

function formatProviderLabel(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function compareProviderProducts(
  left: CreatorPackageProductSummary,
  right: CreatorPackageProductSummary
): number {
  return (
    left.provider.localeCompare(right.provider) ||
    left.providerProductRef.localeCompare(right.providerProductRef) ||
    left._id.localeCompare(right._id)
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getProductTitle(product: CreatorPackageProductSummary): string {
  return product.displayName?.trim() || product.productId;
}

function getProductSearchText(product: CreatorPackageProductSummary): string {
  return [
    getProductTitle(product),
    product.provider,
    product.providerProductRef,
    product.canonicalSlug,
    product.creatorDisplayName,
    ...(product.aliases ?? []),
    ...(product.storefronts?.flatMap((storefront) => [
      storefront.provider,
      storefront.providerProductRef,
      storefront.canonicalSlug,
    ]) ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

function getProductStorefronts(product: CreatorPackageProductSummary) {
  return product.storefronts?.length
    ? product.storefronts
    : [
        {
          catalogProductId: product._id,
          productId: product.productId,
          provider: product.provider,
          providerProductRef: product.providerProductRef,
        },
      ];
}

function getProductReadinessSummary(product: CreatorPackageProductSummary): string {
  if (product.status === 'archived') return 'Uploads paused';
  return product.packageId ? 'Ready for updates' : 'Ready for first upload';
}

function getReleaseStateLabel(state: CreatorPackageVersionStatus['state']): string {
  switch (state) {
    case 'queued':
      return 'Queued';
    case 'uploading':
      return 'Uploading';
    case 'preparing':
      return 'Preparing';
    case 'publishing':
      return 'Publishing';
    case 'recovering':
      return 'Recovering';
    case 'ready':
      return 'Ready';
    case 'failed':
      return 'Failed';
    case 'deleted':
      return 'Deleted';
  }
}

function getPickerProduct(
  entry: CreatorPackagePickerProduct | undefined,
  preferredId?: string
): CreatorPackageProductSummary | null {
  if (!entry) return null;
  return (
    entry.products.find((product) => product._id === preferredId && product.status === 'active') ??
    entry.products.find((product) => product.status === 'active') ??
    null
  );
}

function getPickerCatalogProductIds(
  entry: CreatorPackagePickerProduct | undefined,
  fallbackProduct: CreatorPackageProductSummary
): string[] {
  const catalogProductIds = entry
    ? entry.products.flatMap((product) =>
        product.packageId && product.catalogProductIds?.length
          ? product.catalogProductIds
          : [product._id]
      )
    : fallbackProduct.packageId && fallbackProduct.catalogProductIds?.length
      ? fallbackProduct.catalogProductIds
      : [fallbackProduct._id];
  return [...new Set(catalogProductIds)];
}

function getPickerProviderLabel(entry: CreatorPackagePickerProduct): string {
  return Array.from(
    new Set(
      entry.products.flatMap((product) =>
        getProductStorefronts(product).map((storefront) => formatProviderLabel(storefront.provider))
      )
    )
  )
    .sort((left, right) => left.localeCompare(right))
    .join(' + ');
}

function getPickerContextLabel(entry: CreatorPackagePickerProduct): string {
  const providerLabel = getPickerProviderLabel(entry);
  const collaboratorOwner = entry.products.find(
    (product) => product.accessRole === 'collaborator' && product.creatorDisplayName?.trim()
  )?.creatorDisplayName;
  return collaboratorOwner ? `${collaboratorOwner} · ${providerLabel}` : providerLabel;
}

function getBuyerAccessUrl(product: CreatorPackageProductSummary): string {
  const publicProductSlug = product.publicSlug ?? product.canonicalSlug;
  const path =
    product.publicCreatorSlug && publicProductSlug
      ? `/get-in-unity/${encodeURIComponent(product.publicCreatorSlug)}/${encodeURIComponent(
          publicProductSlug
        )}`
      : buildBuyerProductAccessPath(product._id);
  return typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
}

function getBuyerPrivacyNoticeUrl(): string {
  const path = '/legal/verification-and-attestation';
  return typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
}

function toEditionId(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function getFriendlyUploadError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Package upload failed.';
  if (message.startsWith('tus:')) {
    return 'The upload could not start. Check your connection and try again.';
  }
  return message;
}

function uploadPackageAndWait(input: {
  catalogTierId?: string;
  editionId: string;
  file: File;
  packageId: string;
  version: string;
  catalogProductIds: string[];
  onProgress: (progress: number) => void;
  onAuthorized: (versionId: string) => void;
  onTransferComplete: (versionId: string) => void;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let versionId = '';
    const resolveOnce = () => {
      if (settled) return;
      if (!versionId) {
        rejectOnce(new Error('Upload authorization did not return a version identifier.'));
        return;
      }
      settled = true;
      input.onTransferComplete(versionId);
      resolve(versionId);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    void uploadPackageFile({
      ...input,
      onAuthorized: (authorization) => {
        versionId = authorization.versionId;
        input.onAuthorized(versionId);
      },
      onSuccess: resolveOnce,
      onError: rejectOnce,
    }).catch((error: unknown) => {
      rejectOnce(error instanceof Error ? error : new Error('Package upload failed'));
    });
  });
}

const PACKAGE_READY_POLL_MIN_INTERVAL_MS = 500;
const PACKAGE_READY_POLL_MAX_INTERVAL_MS = 10_000;
const PACKAGE_READY_POLL_BACKOFF_FACTOR = 1.6;
const PACKAGE_READY_POLL_BUDGET_MS = 45 * 60 * 1000;

export function packageReadyPollDelayMs(attempt: number, jitter = Math.random()): number {
  const base = Math.min(
    PACKAGE_READY_POLL_MAX_INTERVAL_MS,
    PACKAGE_READY_POLL_MIN_INTERVAL_MS * PACKAGE_READY_POLL_BACKOFF_FACTOR ** attempt
  );
  return Math.round(base * (0.8 + jitter * 0.4));
}

class PackageVersionTerminalError extends Error {}

class PackageVersionStatusCheckError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown
  ) {
    super(message);
  }
}

type PackageVersionProgress = {
  estimatedStartAt: string | null;
  queuePosition: number | null;
  state: 'queued' | 'uploading' | 'preparing' | 'publishing' | 'recovering';
};

async function waitForPackageVersionReady(
  catalogProductId: string,
  packageId: string,
  editionId: string,
  versionId: string,
  onStatus: (status: PackageVersionProgress) => void,
  signal?: AbortSignal
): Promise<CreatorPackageProductSummary | null> {
  const deadline = Date.now() + PACKAGE_READY_POLL_BUDGET_MS;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    if (signal?.aborted) return null;
    let status: CreatorPackageVersionStatus;
    try {
      status = await getCreatorPackageVersionStatus(packageId, editionId, versionId);
    } catch (error) {
      if (signal?.aborted) return null;
      throw new PackageVersionStatusCheckError(
        'We could not check preparation status. The package remains safe on the server.',
        error
      );
    }
    if (signal?.aborted) return null;
    if (status.state === 'ready') {
      try {
        return await getCreatorPackageProduct(catalogProductId);
      } catch (error) {
        if (signal?.aborted) return null;
        throw new PackageVersionStatusCheckError(
          'The package is ready, but we could not refresh its details. The package remains safe on the server.',
          error
        );
      }
    }
    if (status.state === 'failed') {
      throw new PackageVersionTerminalError(
        'We could not prepare this version. Review the package file, then upload a new version or retry this draft.'
      );
    }
    if (status.state === 'deleted') {
      throw new PackageVersionTerminalError(
        'The uploaded version was removed before it became available.'
      );
    }
    onStatus({
      estimatedStartAt: status.estimatedStartAt,
      queuePosition: status.queuePosition,
      state: status.state,
    });
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, packageReadyPollDelayMs(attempt));
      signal?.addEventListener('abort', finish, { once: true });
    });
  }
  return null;
}

function isServerProcessingStatus(
  status: SelectedUpload['status'] | CreatorPackageVersionStatus['state']
): status is 'uploading' | 'queued' | 'preparing' | 'publishing' | 'recovering' {
  return (
    status === 'uploading' ||
    status === 'queued' ||
    status === 'preparing' ||
    status === 'publishing' ||
    status === 'recovering'
  );
}

function formatElapsedSuffix(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 5) {
    return '';
  }
  if (totalSeconds < 60) {
    return ` · ${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return ` · ${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

const UPLOAD_JOURNEY_STEPS = [
  { description: 'Sending your file to our servers.', title: 'Upload' },
  { description: 'Unpacking the package and checking what is inside.', title: 'Check' },
  {
    description: 'Splitting the release up so buyers only download what changed.',
    title: 'Optimize delivery',
  },
  { description: 'Making this version available to buyers.', title: 'Publish' },
] as const;

function getUploadJourneyPosition(upload: SelectedUpload): number {
  switch (upload.status) {
    case 'uploading':
      return upload.progress >= 100 ? 1 : Math.min(0.99, upload.progress / 100);
    case 'queued':
      return 1;
    case 'preparing':
      return 2;
    case 'publishing':
      return 3;
    case 'recovering':
      return 3;
    case 'complete':
      return UPLOAD_JOURNEY_STEPS.length;
    default:
      return 0;
  }
}

function getUploadStatusLine(upload: SelectedUpload): string {
  switch (upload.status) {
    case 'uploading':
      return upload.progress >= 100
        ? 'Checking your package...'
        : `Uploading package: ${upload.progress}%`;
    case 'queued':
      return 'Waiting for a preparation slot...';
    case 'preparing':
      return 'Optimizing delivery...';
    case 'publishing':
      return 'Publishing version...';
    case 'recovering':
      return 'Recovering preparation...';
    default:
      return '';
  }
}

function formatQueueDetail(upload: SelectedUpload): string | null {
  const parts: string[] = [];
  if (typeof upload.queuePosition === 'number' && upload.queuePosition > 0) {
    parts.push(
      upload.queuePosition === 1
        ? 'Next in the queue'
        : `Position ${upload.queuePosition} in the queue`
    );
  }
  if (upload.estimatedStartAt) {
    const startsAt = new Date(upload.estimatedStartAt);
    if (!Number.isNaN(startsAt.getTime())) {
      parts.push(
        `starts around ${startsAt.toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit',
        })}`
      );
    }
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function UploadStatusAlert({ elapsedMs, upload }: { elapsedMs: number; upload: SelectedUpload }) {
  if (upload.status === 'ready') return null;

  if (upload.status === 'failed') {
    return (
      <Alert className="mt-4" status="danger">
        <Alert.Indicator>
          <Icon name="alert" className="size-4" />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Title>This version could not be prepared</Alert.Title>
          <Alert.Description>
            {upload.errorMessage ?? 'The package could not be prepared.'}
            {upload.versionId
              ? ' Nothing was lost: retry the upload, or check the package status to pick it back up.'
              : ''}
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  if (upload.status === 'complete') {
    return (
      <Alert className="mt-4" status="success">
        <Alert.Indicator>
          <Icon name="success" className="size-4" />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Title>Version ready</Alert.Title>
          <Alert.Description>Buyers can install this version now.</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  const position = getUploadJourneyPosition(upload);
  const isTransferring = upload.status === 'uploading' && upload.progress < 100;
  const queueDetail = formatQueueDetail(upload);

  return (
    <Alert className="mt-4" status="accent">
      <Alert.Indicator>
        <Icon name="clock" className="size-4" />
      </Alert.Indicator>
      <Alert.Content>
        <Alert.Title>
          {getUploadStatusLine(upload)}
          {formatElapsedSuffix(elapsedMs)}
        </Alert.Title>
        <Alert.Description>
          {queueDetail ??
            (isTransferring
              ? 'Your browser is sending the file, so keep this tab open until the transfer finishes.'
              : 'The server has your file and is working on it. You can close this window or the tab; the result waits for you here and in the package details.')}
        </Alert.Description>
        <ProgressBar
          aria-label="Package preparation progress"
          className="mt-3"
          size="sm"
          {...(isTransferring ? { value: upload.progress } : { isIndeterminate: true })}
        >
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
        <Stepper className="mt-4" currentStep={position} orientation="vertical" size="sm">
          {UPLOAD_JOURNEY_STEPS.map((step) => (
            <Stepper.Step key={step.title}>
              <Stepper.Indicator />
              <Stepper.Content>
                <Stepper.Title>{step.title}</Stepper.Title>
                <Stepper.Description>{step.description}</Stepper.Description>
              </Stepper.Content>
              <Stepper.Separator />
            </Stepper.Step>
          ))}
        </Stepper>
      </Alert.Content>
    </Alert>
  );
}

function getUploadHeadline(upload: SelectedUpload): string {
  switch (upload.status) {
    case 'uploading':
      return upload.progress >= 100
        ? `Confirming ${upload.fileName}`
        : `Uploading ${upload.fileName}: ${upload.progress}%`;
    case 'queued':
      return `Waiting to prepare ${upload.fileName}`;
    case 'preparing':
      return `Preparing ${upload.fileName}`;
    case 'publishing':
      return `Publishing ${upload.fileName}`;
    case 'recovering':
      return `Recovering ${upload.fileName}`;
    case 'complete':
      return 'Upload complete';
    case 'failed':
      return `${upload.fileName} needs attention`;
    default:
      return upload.fileName;
  }
}

function getUploadSupportingCopy(upload: SelectedUpload): string {
  switch (upload.status) {
    case 'uploading':
      return upload.progress >= 100
        ? 'The package is safe on the server while preparation begins.'
        : 'You can keep working while the upload continues.';
    case 'queued':
      return 'The upload is waiting for an available preparation slot.';
    case 'preparing':
      return 'We are checking and preparing this version.';
    case 'publishing':
      return 'Preparation finished. We are making this version available to buyers.';
    case 'recovering':
      return 'The server is automatically resuming preparation from its last safe checkpoint.';
    case 'complete':
      return '';
    case 'failed':
      return 'Open the upload to review safe retry guidance.';
    default:
      return '';
  }
}

function ProductRow({
  product,
  isCopying,
  onCopyAccessLink,
  onOpenDetails,
  onUpload,
}: {
  product: CreatorPackageProductSummary;
  isCopying: boolean;
  onCopyAccessLink: () => void;
  onOpenDetails: () => void;
  onUpload: () => void;
}) {
  const providerIconPath = getAccountProviderIconPath(product.provider);
  const isArchived = product.status === 'archived';

  return (
    <Card className="pm-product-row rounded-xl shadow-none">
      <Card.Content className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <button
          type="button"
          className="group flex min-w-0 flex-1 gap-3 text-left"
          aria-label={`Open details for ${getProductTitle(product)}`}
          onClick={onOpenDetails}
        >
          <div className="pm-icon-shell flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl">
            {product.thumbnailUrl ? (
              <img
                src={product.thumbnailUrl}
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
              <Icon name="store" className="size-5" />
            )}
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-foreground min-w-0 truncate text-sm font-semibold leading-6 group-hover:underline">
                {getProductTitle(product)}
              </p>
              {getProductStorefronts(product).map((storefront) => (
                <Chip
                  key={storefront.catalogProductId}
                  size="sm"
                  variant="soft"
                  className="text-foreground/60"
                >
                  {formatProviderLabel(storefront.provider)}
                </Chip>
              ))}
              {product.accessRole === 'collaborator' && product.creatorDisplayName ? (
                <Chip size="sm" variant="soft" className="text-foreground/60">
                  {product.creatorDisplayName}
                </Chip>
              ) : null}
              {isArchived ? (
                <Chip size="sm" variant="soft">
                  Hidden
                </Chip>
              ) : null}
            </div>
            <p className="pm-subtle-copy break-words text-sm leading-6">
              {getProductReadinessSummary(product)}
            </p>
          </div>
        </button>
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <YucpButton yucp="ghost" size="sm" isLoading={isCopying} onPress={onCopyAccessLink}>
            <Icon name="copy" className="size-4" />
            {isCopying ? 'Copying...' : 'Copy store-page link'}
          </YucpButton>
          {!isArchived ? (
            <Button size="sm" variant="outline" onPress={onUpload}>
              <Icon name="upload" className="size-4" />
              Upload
            </Button>
          ) : null}
        </div>
      </Card.Content>
    </Card>
  );
}

function ProductDetailsSheet({
  catalogProductId,
  isOpen,
  onOpenChange,
  onUpload,
}: {
  catalogProductId: string | null;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onUpload: (product: CreatorPackageProductSummary) => void;
}) {
  const { canRunPanelQueries, markSessionExpired } = useDashboardSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editionEditor, setEditionEditor] = useState<{
    catalogTierIds: string[];
    displayName: string;
    editionId: string;
    isNew: boolean;
    priority: number;
  } | null>(null);
  const [selectedHistoryEditionId, setSelectedHistoryEditionId] = useState('standard');
  const [isBootstrapDownloadOpen, setIsBootstrapDownloadOpen] = useState(false);
  const [bootstrapDownloadMode, setBootstrapDownloadMode] = useState<'latest' | 'specific'>(
    'latest'
  );
  const [bootstrapEditionId, setBootstrapEditionId] = useState('standard');
  const [selectedBootstrapVersionId, setSelectedBootstrapVersionId] = useState<string | null>(null);
  const [isCopyingPrivacyNotice, setIsCopyingPrivacyNotice] = useState(false);
  const [storefrontSearch, setStorefrontSearch] = useState('');
  const [bootstrapPackageName, setBootstrapPackageName] = useState('');
  const [publicSlugDraft, setPublicSlugDraft] = useState('');
  const detailQuery = useQuery({
    queryKey: ['creator-package-product', catalogProductId],
    queryFn: () => getCreatorPackageProduct(catalogProductId ?? ''),
    enabled: canRunPanelQueries && isOpen && Boolean(catalogProductId),
    retry: false,
  });
  const packageId = detailQuery.data?.packageId;
  const versionHistoryQueryKey = [
    'creator-package-versions',
    packageId,
    selectedHistoryEditionId,
  ] as const;
  const versionHistoryQuery = useInfiniteQuery({
    queryKey: versionHistoryQueryKey,
    queryFn: ({ pageParam }) =>
      listCreatorPackageVersions(packageId ?? '', selectedHistoryEditionId, {
        ...(pageParam ? { cursor: pageParam } : {}),
        limit: 50,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    enabled: canRunPanelQueries && isOpen && Boolean(packageId),
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.data.some((entry) => isServerProcessingStatus(entry.state))
      )
        ? 10_000
        : false,
    retry: false,
  });
  const packageVersions = versionHistoryQuery.data?.pages.flatMap((page) => page.data) ?? [];
  const availableEditions = useMemo(
    () => (detailQuery.data ? getCreatorPackageEditionOptions(detailQuery.data) : []),
    [detailQuery.data]
  );
  const historyEditions = useMemo(
    () => [
      {
        displayName: 'Standard',
        editionId: 'standard',
        status: 'active' as const,
      },
      ...(detailQuery.data?.packageEditions
        ?.filter((edition) => edition.editionId !== 'standard')
        .map((edition) => ({
          displayName: edition.displayName,
          editionId: edition.editionId,
          status: edition.status,
        })) ?? []),
    ],
    [detailQuery.data?.packageEditions]
  );
  const bootstrapVersionsQuery = useInfiniteQuery({
    queryKey: ['creator-package-bootstrap-versions', packageId, bootstrapEditionId],
    queryFn: ({ pageParam }) =>
      listCreatorPackageVersions(packageId ?? '', bootstrapEditionId, {
        ...(pageParam ? { cursor: pageParam } : {}),
        limit: 100,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    enabled:
      canRunPanelQueries &&
      isOpen &&
      isBootstrapDownloadOpen &&
      Boolean(packageId) &&
      Boolean(bootstrapEditionId),
    retry: false,
  });
  const eligibleBootstrapVersions = useMemo(
    () =>
      (bootstrapVersionsQuery.data?.pages.flatMap((page) => page.data) ?? []).filter((entry) =>
        isStrictSemanticVersion(entry.version)
      ),
    [bootstrapVersionsQuery.data]
  );
  const stableBootstrapVersions = useMemo(
    () => eligibleBootstrapVersions.filter((entry) => !isPrereleaseSemanticVersion(entry.version)),
    [eligibleBootstrapVersions]
  );
  const selectedBootstrapVersion =
    eligibleBootstrapVersions.find((entry) => entry.versionId === selectedBootstrapVersionId) ??
    null;
  const vccLinkQuery = useQuery({
    queryKey: ['creator-package-vcc-link', packageId],
    queryFn: () => getCreatorPackageVccLink(packageId ?? ''),
    enabled: canRunPanelQueries && isOpen && Boolean(catalogProductId) && Boolean(packageId),
    retry: false,
  });
  const storefrontCandidatesQuery = useQuery({
    queryKey: creatorProductPickerQueryKey,
    queryFn: listCreatorPackagePickerProducts,
    enabled:
      canRunPanelQueries &&
      isOpen &&
      Boolean(catalogProductId) &&
      Boolean(detailQuery.data?.packageId),
    retry: false,
  });
  useEffect(() => {
    if (
      selectedBootstrapVersionId &&
      eligibleBootstrapVersions.some((entry) => entry.versionId === selectedBootstrapVersionId)
    ) {
      return;
    }
    setSelectedBootstrapVersionId(eligibleBootstrapVersions[0]?.versionId ?? null);
  }, [eligibleBootstrapVersions, selectedBootstrapVersionId]);
  const bootstrapDownloadMutation = useMutation({
    mutationFn: (format: 'vpm' | 'unitypackage') => {
      if (!packageId) {
        throw new Error('Upload a package before downloading a bootstrap.');
      }
      if (vccLinkQuery.data?.status !== 'active') {
        throw new Error('Enable Unity access before downloading a bootstrap.');
      }
      if (bootstrapDownloadMode === 'specific' && !selectedBootstrapVersionId) {
        throw new Error('Choose the release to pin into this bootstrap.');
      }
      return downloadCreatorPackageBootstrap({
        format,
        packageId,
        selection:
          bootstrapDownloadMode === 'specific'
            ? {
                editionId: bootstrapEditionId,
                mode: 'specific',
                versionId: selectedBootstrapVersionId as string,
              }
            : { editionId: bootstrapEditionId, mode: 'latest' },
      });
    },
    onSuccess: ({ filename }) => {
      toast.success('Bootstrap downloaded', { description: filename });
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not download the bootstrap', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    },
  });
  const createVccLinkMutation = useMutation({
    mutationFn: () => {
      if (!packageId) {
        throw new Error('Upload a package before creating Unity access.');
      }
      return createCreatorPackageVccLink(packageId);
    },
    onSuccess: (link) => {
      queryClient.setQueryData(['creator-package-vcc-link', packageId], link);
      toast.success('Unity access is ready', {
        description: 'Verified buyers now receive this package in their tailored repository.',
      });
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not create Unity access', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    },
  });
  const revokeVccLinkMutation = useMutation({
    mutationFn: () => {
      if (!packageId) {
        throw new Error('Upload a package before revoking Unity access.');
      }
      return revokeCreatorPackageVccLink(packageId);
    },
    onSuccess: () => {
      const currentLink = queryClient.getQueryData(['creator-package-vcc-link', packageId]);
      const bootstrapDownloadUrl =
        currentLink &&
        typeof currentLink === 'object' &&
        'bootstrapDownloadUrl' in currentLink &&
        typeof currentLink.bootstrapDownloadUrl === 'string'
          ? currentLink.bootstrapDownloadUrl
          : '';
      const unityPackageDownloadUrl =
        currentLink &&
        typeof currentLink === 'object' &&
        'unityPackageDownloadUrl' in currentLink &&
        typeof currentLink.unityPackageDownloadUrl === 'string'
          ? currentLink.unityPackageDownloadUrl
          : '';
      queryClient.setQueryData(['creator-package-vcc-link', packageId], {
        status: 'inactive',
        bootstrapDownloadUrl,
        unityPackageDownloadUrl,
      });
      toast.success('Unity access revoked', {
        description: 'This package was removed from buyer repositories.',
      });
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not revoke Unity access', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    },
  });
  const saveBootstrapPresentationMutation = useMutation({
    mutationFn: () => {
      if (!packageId) {
        throw new Error('Upload a package before changing its Unity name.');
      }
      const packageName = bootstrapPackageName.trim();
      if (!packageName) {
        throw new Error('Enter the package name that customers see in Unity.');
      }
      if (new TextEncoder().encode(packageName).byteLength > 120) {
        throw new Error('The Unity package name must use 120 bytes or fewer.');
      }
      return updateCreatorPackagePresentation(packageId, packageName);
    },
    onSuccess: async (presentation) => {
      setBootstrapPackageName(presentation.packageName);
      queryClient.setQueryData<CreatorPackageProductSummary>(
        ['creator-package-product', catalogProductId],
        (current) =>
          current
            ? {
                ...current,
                packageName: presentation.packageName,
              }
            : current
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: creatorProductsQueryKey }),
        queryClient.invalidateQueries({ queryKey: creatorProductPickerQueryKey }),
      ]);
      toast.success('Unity package name published', {
        description: 'New bootstrap installs now use this name.',
      });
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not publish the Unity package name', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    },
  });
  const savePublicLinkMutation = useMutation({
    mutationFn: () => {
      if (!packageId) {
        throw new Error('Upload a package before changing its public product link.');
      }
      const publicSlug = publicSlugDraft.trim();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(publicSlug) || publicSlug.length > 64) {
        throw new Error('Use lowercase letters, numbers, and hyphens for the public product link.');
      }
      return updateCreatorPackagePublicLink(packageId, publicSlug);
    },
    onSuccess: async (result) => {
      setPublicSlugDraft(result.publicSlug);
      queryClient.setQueryData<CreatorPackageProductSummary>(
        ['creator-package-product', catalogProductId],
        (current) => (current ? { ...current, publicSlug: result.publicSlug } : current)
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: creatorProductsQueryKey }),
        queryClient.invalidateQueries({ queryKey: creatorProductPickerQueryKey }),
      ]);
      toast.success('Public product link saved', {
        description: 'Previously shared product paths continue to work.',
      });
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not save the public product link', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    },
  });
  const deleteVersionMutation = useMutation({
    mutationFn: (input: { editionId: string; versionId: string }) => {
      if (!packageId) {
        throw new Error('Open a package before deleting a release.');
      }
      return deleteCreatorPackageVersion(packageId, input.editionId, input.versionId);
    },
    onSuccess: async (_result, { editionId, versionId }) => {
      if (!packageId) return;
      const deletedPageQueryKey = ['creator-package-versions', packageId, editionId] as const;
      queryClient.setQueryData<InfiniteData<CreatorPackageVersionListPage, string | undefined>>(
        deletedPageQueryKey,
        (current) =>
          current
            ? {
                ...current,
                pages: current.pages.map((page) => ({
                  ...page,
                  data: page.data.filter((version) => version.versionId !== versionId),
                })),
              }
            : current
      );
      await Promise.all([
        queryClient.invalidateQueries({
          exact: true,
          queryKey: deletedPageQueryKey,
        }),
        queryClient.invalidateQueries({ queryKey: creatorProductsQueryKey }),
      ]);
      toast.success('Release deleted', {
        description: 'Files that another release needs remain available.',
      });
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not delete release', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    },
  });
  const saveEditionMutation = useMutation({
    mutationFn: () => {
      if (!catalogProductId || !detailQuery.data || !editionEditor) {
        throw new Error('Open an edition before saving it.');
      }
      const editionId = editionEditor.editionId.trim();
      const displayName = editionEditor.displayName.trim();
      if (!displayName) {
        throw new Error('Enter an edition name.');
      }
      if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(editionId)) {
        throw new Error('Use lowercase letters, numbers, and hyphens for the short name.');
      }
      return saveCreatorPackageEdition(catalogProductId, {
        catalogProductIds: detailQuery.data.catalogProductIds?.length
          ? detailQuery.data.catalogProductIds
          : [detailQuery.data._id],
        catalogTierIds: editionEditor.catalogTierIds,
        displayName,
        editionId,
        priority: editionEditor.priority,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['creator-package-product', catalogProductId],
        }),
        queryClient.invalidateQueries({ queryKey: creatorProductsQueryKey }),
        queryClient.invalidateQueries({ queryKey: creatorProductPickerQueryKey }),
      ]);
      setEditionEditor(null);
      toast.success('Package edition saved', {
        description: 'New uploads can now target this edition.',
      });
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not save package edition', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    },
  });
  const archiveEditionMutation = useMutation({
    mutationFn: (editionId: string) => {
      if (!catalogProductId) {
        throw new Error('Open a package before archiving an edition.');
      }
      return archiveCreatorPackageEdition(catalogProductId, editionId);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['creator-package-product', catalogProductId],
        }),
        queryClient.invalidateQueries({ queryKey: creatorProductsQueryKey }),
        queryClient.invalidateQueries({ queryKey: creatorProductPickerQueryKey }),
      ]);
      toast.success('Package edition archived', {
        description: 'Buyers stop receiving this edition. Its release records remain intact.',
      });
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not archive package edition', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    },
  });
  const bindStorefrontMutation = useMutation({
    mutationFn: (targetCatalogProductId: string) => {
      if (!catalogProductId) {
        throw new Error('Open a package before linking a storefront.');
      }
      return bindCreatorPackageStorefront(catalogProductId, targetCatalogProductId);
    },
    onSuccess: async () => {
      setStorefrontSearch('');
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['creator-package-product', catalogProductId],
        }),
        queryClient.invalidateQueries({ queryKey: creatorProductsQueryKey }),
        queryClient.invalidateQueries({ queryKey: creatorProductPickerQueryKey }),
      ]);
      toast.success('Storefront linked', {
        description: 'Buyers can verify this product through the same Unity package.',
      });
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not link storefront', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    },
  });
  const unbindStorefrontMutation = useMutation({
    mutationFn: (targetCatalogProductId: string) => {
      if (!catalogProductId) {
        throw new Error('Open a package before unlinking a storefront.');
      }
      return unbindCreatorPackageStorefront(catalogProductId, targetCatalogProductId);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['creator-package-product', catalogProductId],
        }),
        queryClient.invalidateQueries({ queryKey: creatorProductsQueryKey }),
        queryClient.invalidateQueries({ queryKey: creatorProductPickerQueryKey }),
      ]);
      toast.success('Storefront unlinked', {
        description: 'This listing no longer grants access to the package.',
      });
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not unlink storefront', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    },
  });

  useEffect(() => {
    if (isDashboardAuthError(detailQuery.error)) {
      markSessionExpired();
    }
  }, [detailQuery.error, markSessionExpired]);

  useEffect(() => {
    if (isDashboardAuthError(vccLinkQuery.error)) {
      markSessionExpired();
    }
  }, [markSessionExpired, vccLinkQuery.error]);

  useEffect(() => {
    if (isDashboardAuthError(versionHistoryQuery.error)) {
      markSessionExpired();
    }
  }, [markSessionExpired, versionHistoryQuery.error]);

  useEffect(() => {
    if (!detailQuery.data) {
      return;
    }
    setBootstrapPackageName(
      detailQuery.data.packageName?.trim() || getProductTitle(detailQuery.data)
    );
    setPublicSlugDraft(
      detailQuery.data.publicSlug?.trim() ||
        detailQuery.data.canonicalSlug?.trim() ||
        detailQuery.data.productId
    );
  }, [detailQuery.data]);

  async function copyBuyerPrivacyNotice(): Promise<void> {
    setIsCopyingPrivacyNotice(true);
    const copied = await copyToClipboard(getBuyerPrivacyNoticeUrl());
    setIsCopyingPrivacyNotice(false);
    if (copied) {
      toast.success('Buyer privacy notice copied');
      return;
    }
    toast.error('Could not copy to clipboard');
  }

  function handleOpenChange(nextIsOpen: boolean): void {
    if (!nextIsOpen) {
      setSelectedHistoryEditionId('standard');
      setEditionEditor(null);
      setIsCopyingPrivacyNotice(false);
      setStorefrontSearch('');
      setBootstrapPackageName('');
      setPublicSlugDraft('');
    }
    onOpenChange(nextIsOpen);
  }

  function openNewEdition(): void {
    setEditionEditor({
      catalogTierIds: [],
      displayName: '',
      editionId: '',
      isNew: true,
      priority: 0,
    });
  }

  function openEditionEditor(edition: CreatorPackageEditionSummary): void {
    setEditionEditor({
      catalogTierIds: edition.catalogTierIds,
      displayName: edition.displayName,
      editionId: edition.editionId,
      isNew: false,
      priority: edition.priority,
    });
  }

  function toggleEditionTier(tierId: string): void {
    setEditionEditor((current) => {
      if (!current) return current;
      const catalogTierIds = current.catalogTierIds.includes(tierId)
        ? current.catalogTierIds.filter((candidate) => candidate !== tierId)
        : [...current.catalogTierIds, tierId];
      return { ...current, catalogTierIds };
    });
  }

  const linkedStorefronts = detailQuery.data ? getProductStorefronts(detailQuery.data) : [];
  const linkedCatalogProductIds = new Set(
    linkedStorefronts.map((storefront) => storefront.catalogProductId)
  );
  const normalizedStorefrontSearch = storefrontSearch.trim().toLocaleLowerCase();
  const availableStorefronts = (storefrontCandidatesQuery.data ?? [])
    .flatMap((entry) => entry.products)
    .filter(
      (product, index, products) =>
        product.status === 'active' &&
        !product.packageId &&
        !linkedCatalogProductIds.has(product._id) &&
        products.findIndex((candidate) => candidate._id === product._id) === index &&
        (!normalizedStorefrontSearch ||
          getProductSearchText(product).includes(normalizedStorefrontSearch))
    )
    .sort(compareProviderProducts);

  return (
    <>
      <Sheet isOpen={isOpen} onOpenChange={handleOpenChange}>
        <Sheet.Backdrop variant="blur">
          <Sheet.Content
            className="pm-sheet-content mx-auto max-w-[760px]"
            aria-label="Product details"
          >
            <Sheet.Dialog className="pm-sheet-dialog" aria-label="Product details">
              <Sheet.Handle />
              <Sheet.CloseTrigger />
              <Sheet.Header>
                <Sheet.Heading>Product details</Sheet.Heading>
              </Sheet.Header>
              <Sheet.Body className="space-y-5">
                {detailQuery.isPending ? (
                  <output
                    className="pm-muted-card space-y-3 rounded-2xl p-4"
                    aria-label="Loading product details"
                  >
                    <Skeleton className="h-5 w-2/5 rounded" />
                    <Skeleton className="h-4 w-4/5 rounded" />
                    <Skeleton className="h-16 w-full rounded-xl" />
                  </output>
                ) : detailQuery.isError || !detailQuery.data ? (
                  <div className="space-y-3">
                    <AccountInlineError message="Failed to load this product. Try again." />
                    <YucpButton
                      yucp="secondary"
                      isLoading={detailQuery.isFetching}
                      onPress={() => void detailQuery.refetch()}
                    >
                      Retry
                    </YucpButton>
                  </div>
                ) : (
                  <>
                    <Card className="pm-muted-card rounded-2xl shadow-none">
                      <Card.Content className="space-y-4 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="space-y-1">
                            <p className="text-foreground text-base font-semibold">
                              {getProductTitle(detailQuery.data)}
                            </p>
                            <p className="pm-subtle-copy break-words text-sm">
                              {Array.from(
                                new Set(
                                  getProductStorefronts(detailQuery.data).map((storefront) =>
                                    formatProviderLabel(storefront.provider)
                                  )
                                )
                              ).join(' · ')}
                            </p>
                          </div>
                          {detailQuery.data.status === 'active' ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onPress={() => onUpload(detailQuery.data)}
                            >
                              <Icon name="upload" className="size-4" />
                              Upload update
                            </Button>
                          ) : (
                            <Chip size="sm" variant="soft" className="text-foreground/60">
                              Hidden
                            </Chip>
                          )}
                        </div>
                        <div className="pm-inline-note space-y-3 rounded-[18px] p-3">
                          <div>
                            <p className="text-foreground text-sm font-semibold">
                              Public product link
                            </p>
                            <p className="pm-subtle-copy mt-1 text-xs leading-5">
                              Use a readable product path in store delivery notes. Renames keep the
                              previous path working.
                            </p>
                          </div>
                          {detailQuery.data.packageId ? (
                            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                              <YucpInput
                                aria-label="Public product link"
                                value={publicSlugDraft}
                                isDisabled={savePublicLinkMutation.isPending}
                                onValueChange={setPublicSlugDraft}
                              />
                              <YucpButton
                                yucp="secondary"
                                size="sm"
                                aria-label="Save public product link"
                                isLoading={savePublicLinkMutation.isPending}
                                isDisabled={
                                  savePublicLinkMutation.isPending ||
                                  !publicSlugDraft.trim() ||
                                  publicSlugDraft.trim() === detailQuery.data.publicSlug
                                }
                                onPress={() => savePublicLinkMutation.mutate()}
                              >
                                {savePublicLinkMutation.isPending ? 'Saving...' : 'Save link'}
                              </YucpButton>
                            </div>
                          ) : null}
                          <p className="pm-subtle-copy break-all text-sm leading-6">
                            {getBuyerAccessUrl({
                              ...detailQuery.data,
                              publicSlug:
                                detailQuery.data.packageId && publicSlugDraft
                                  ? publicSlugDraft
                                  : detailQuery.data.publicSlug,
                            })}
                          </p>
                        </div>
                        <div className="pm-inline-note flex flex-col gap-3 rounded-[18px] p-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="text-foreground text-sm font-semibold">
                              Buyer privacy notice
                            </p>
                            <p className="pm-subtle-copy mt-1 text-sm leading-6">
                              Add this sourced notice to your product listing.
                            </p>
                          </div>
                          <YucpButton
                            yucp="ghost"
                            size="sm"
                            isLoading={isCopyingPrivacyNotice}
                            isDisabled={isCopyingPrivacyNotice}
                            onPress={() => void copyBuyerPrivacyNotice()}
                          >
                            <Icon name="copy" className="size-4" />
                            {isCopyingPrivacyNotice ? 'Copying...' : 'Copy buyer privacy notice'}
                          </YucpButton>
                        </div>
                      </Card.Content>
                    </Card>

                    {detailQuery.data.packageId ? (
                      <Card className="pm-card rounded-2xl shadow-none">
                        <Card.Header className="p-4 pb-2">
                          <div className="space-y-1">
                            <p className="text-foreground text-sm font-semibold">
                              Linked storefronts
                            </p>
                            <p className="pm-subtle-copy text-xs leading-5">
                              Link listings that sell this same package. Names alone never link
                              products.
                            </p>
                          </div>
                        </Card.Header>
                        <Card.Content className="space-y-3 p-4 pt-0">
                          <div className="space-y-2">
                            {linkedStorefronts.map((storefront) => {
                              const providerLabel = formatProviderLabel(storefront.provider);
                              const isUnlinking =
                                unbindStorefrontMutation.isPending &&
                                unbindStorefrontMutation.variables === storefront.catalogProductId;
                              return (
                                <div
                                  key={storefront.catalogProductId}
                                  className="pm-muted-panel space-y-3 rounded-xl p-3"
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div>
                                      <p className="text-foreground text-sm font-medium">
                                        {providerLabel}
                                      </p>
                                      <p className="pm-subtle-copy mt-1 text-xs">
                                        {storefront.displayName || storefront.productId}
                                      </p>
                                    </div>
                                    {linkedStorefronts.length > 1 ? (
                                      <HoldConfirmButton
                                        accessibleLabel={`Hold to unlink ${providerLabel} storefront`}
                                        confirmLabel="Keep holding to unlink..."
                                        isDisabled={
                                          bindStorefrontMutation.isPending ||
                                          (unbindStorefrontMutation.isPending && !isUnlinking)
                                        }
                                        isPending={isUnlinking}
                                        onConfirm={() =>
                                          unbindStorefrontMutation.mutate(
                                            storefront.catalogProductId
                                          )
                                        }
                                        pendingLabel="Unlinking..."
                                      >
                                        Unlink
                                      </HoldConfirmButton>
                                    ) : null}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <div className="pm-field-stack">
                            <Label className="pm-field-label" htmlFor="storefront-link-search">
                              Add another storefront
                            </Label>
                            <YucpInput
                              id="storefront-link-search"
                              aria-label="Search storefronts to link"
                              placeholder="Search your synced products"
                              value={storefrontSearch}
                              onValueChange={setStorefrontSearch}
                            />
                          </div>
                          {storefrontCandidatesQuery.isPending ? (
                            <output
                              className="pm-muted-panel block space-y-2 rounded-xl p-3"
                              aria-label="Loading storefronts"
                            >
                              <Skeleton className="h-4 w-2/5 rounded" />
                              <Skeleton className="h-9 w-full rounded-xl" />
                            </output>
                          ) : availableStorefronts.length > 0 ? (
                            <div className="space-y-2">
                              {availableStorefronts.slice(0, 8).map((product) => {
                                const providerLabel = formatProviderLabel(product.provider);
                                const isLinking =
                                  bindStorefrontMutation.isPending &&
                                  bindStorefrontMutation.variables === product._id;
                                return (
                                  <div
                                    key={product._id}
                                    className="pm-muted-panel flex flex-wrap items-center justify-between gap-3 rounded-xl p-3"
                                  >
                                    <div>
                                      <p className="text-foreground text-sm font-medium">
                                        {getProductTitle(product)}
                                      </p>
                                      <p className="pm-subtle-copy mt-1 text-xs">{providerLabel}</p>
                                    </div>
                                    <YucpButton
                                      yucp="secondary"
                                      size="sm"
                                      isLoading={isLinking}
                                      isDisabled={
                                        bindStorefrontMutation.isPending ||
                                        unbindStorefrontMutation.isPending
                                      }
                                      aria-label={
                                        isLinking
                                          ? `Linking ${providerLabel}...`
                                          : `Link ${providerLabel} storefront`
                                      }
                                      onPress={() => bindStorefrontMutation.mutate(product._id)}
                                    >
                                      {isLinking ? 'Linking...' : 'Link storefront'}
                                    </YucpButton>
                                  </div>
                                );
                              })}
                            </div>
                          ) : storefrontSearch.trim() ? (
                            <p className="pm-subtle-copy text-sm">
                              No unlinked storefronts match this search.
                            </p>
                          ) : null}
                        </Card.Content>
                      </Card>
                    ) : null}

                    {detailQuery.data.packageId ? (
                      <Card className="pm-card rounded-2xl shadow-none">
                        <Card.Header className="flex flex-row items-start justify-between gap-3 p-4 pb-2">
                          <div className="space-y-1">
                            <p className="text-foreground text-sm font-semibold">Unity access</p>
                            <p className="pm-subtle-copy max-w-[58ch] text-xs leading-5">
                              Enable this package in each verified buyer's private creator
                              repository.
                            </p>
                          </div>
                          {vccLinkQuery.data?.status === 'active' ? (
                            <Chip size="sm" variant="soft">
                              Enabled
                            </Chip>
                          ) : null}
                        </Card.Header>
                        <Card.Content className="space-y-3 p-4 pt-0">
                          <div className="pm-muted-panel space-y-3 rounded-xl p-3">
                            <div className="space-y-1">
                              <Label
                                className="text-foreground text-sm font-medium"
                                htmlFor="bootstrap-package-name"
                              >
                                Package name in Unity
                              </Label>
                              <p className="pm-subtle-copy text-xs leading-5">
                                Customers see this name in VCC and the Unity importer.
                              </p>
                            </div>
                            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                              <YucpInput
                                id="bootstrap-package-name"
                                aria-label="Bootstrap package name"
                                value={bootstrapPackageName}
                                onValueChange={setBootstrapPackageName}
                                isDisabled={saveBootstrapPresentationMutation.isPending}
                              />
                              <YucpButton
                                yucp="secondary"
                                size="sm"
                                aria-label="Save bootstrap name"
                                isLoading={saveBootstrapPresentationMutation.isPending}
                                isDisabled={
                                  saveBootstrapPresentationMutation.isPending ||
                                  !bootstrapPackageName.trim() ||
                                  bootstrapPackageName.trim() ===
                                    (detailQuery.data.packageName?.trim() ||
                                      getProductTitle(detailQuery.data))
                                }
                                onPress={() => saveBootstrapPresentationMutation.mutate()}
                              >
                                {saveBootstrapPresentationMutation.isPending
                                  ? 'Publishing...'
                                  : 'Save name'}
                              </YucpButton>
                            </div>
                          </div>
                          {vccLinkQuery.isPending ? (
                            <output
                              className="pm-muted-panel grid gap-3 rounded-xl p-3"
                              aria-label="Loading Unity access"
                            >
                              <Skeleton className="h-4 w-2/5 rounded" />
                              <Skeleton className="h-10 w-full rounded-xl" />
                            </output>
                          ) : vccLinkQuery.isError || !vccLinkQuery.data ? (
                            <div className="space-y-3">
                              <AccountInlineError message="Could not load Unity access. Try again." />
                              <YucpButton
                                yucp="secondary"
                                isLoading={vccLinkQuery.isFetching}
                                onPress={() => void vccLinkQuery.refetch()}
                              >
                                Retry Unity access
                              </YucpButton>
                            </div>
                          ) : (
                            <>
                              {vccLinkQuery.data.status === 'active' ? (
                                <div className="pm-muted-panel space-y-1 rounded-xl p-3">
                                  <p className="text-foreground text-sm font-medium">
                                    Buyer repositories enabled
                                  </p>
                                  <p className="pm-subtle-copy text-sm leading-6">
                                    A verified buyer sees this package automatically in the one
                                    private repository they receive for your creator profile.
                                  </p>
                                </div>
                              ) : (
                                <div className="pm-muted-panel flex flex-col gap-3 rounded-xl p-3 sm:flex-row sm:items-center sm:justify-between">
                                  <p className="pm-subtle-copy max-w-[48ch] text-sm leading-6">
                                    Enable this package once. It will appear in every entitled
                                    buyer's existing repository for your creator profile.
                                  </p>
                                  <YucpButton
                                    size="sm"
                                    isLoading={createVccLinkMutation.isPending}
                                    onPress={() => createVccLinkMutation.mutate()}
                                  >
                                    <Icon name="link" className="size-4" />
                                    {createVccLinkMutation.isPending
                                      ? 'Creating access...'
                                      : 'Enable Unity access'}
                                  </YucpButton>
                                </div>
                              )}

                              {vccLinkQuery.data.status === 'active' ? (
                                <p className="pm-subtle-copy text-sm leading-6">
                                  This package disappears from tailored buyer repositories. Packages
                                  already installed in Unity stay in their projects.
                                </p>
                              ) : null}

                              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                                <YucpButton
                                  yucp="secondary"
                                  size="sm"
                                  isDisabled={vccLinkQuery.data.status !== 'active'}
                                  onPress={() => setIsBootstrapDownloadOpen(true)}
                                >
                                  <Icon name="download" className="size-4" />
                                  Download bootstrap
                                </YucpButton>
                                {vccLinkQuery.data.status === 'active' ? (
                                  <HoldConfirmButton
                                    accessibleLabel="Hold to disable Unity access"
                                    confirmLabel="Keep holding to disable..."
                                    isDisabled={createVccLinkMutation.isPending}
                                    isPending={revokeVccLinkMutation.isPending}
                                    onConfirm={() => revokeVccLinkMutation.mutate()}
                                    pendingLabel="Disabling..."
                                  >
                                    Disable Unity access
                                  </HoldConfirmButton>
                                ) : null}
                              </div>
                              {vccLinkQuery.data.status !== 'active' ? (
                                <p className="pm-subtle-copy text-xs leading-5">
                                  Enable Unity access before downloading a bootstrap.
                                </p>
                              ) : null}
                            </>
                          )}
                        </Card.Content>
                      </Card>
                    ) : null}

                    <Card className="pm-card rounded-2xl shadow-none">
                      <Card.Header className="flex flex-row items-start justify-between gap-3 p-4 pb-2">
                        <Card.Title>Package editions</Card.Title>
                        {!editionEditor ? (
                          <Button size="sm" variant="outline" onPress={openNewEdition}>
                            Add edition
                          </Button>
                        ) : null}
                      </Card.Header>
                      <Card.Content className="space-y-3 p-4 pt-0">
                        {editionEditor ? (
                          <div className="pm-inline-note space-y-4 rounded-xl p-3">
                            <div className="pm-form-grid">
                              <div className="pm-field-stack">
                                <p className="pm-field-label">Edition name</p>
                                <YucpInput
                                  aria-label="Edition name"
                                  placeholder="Commercial"
                                  value={editionEditor.displayName}
                                  onValueChange={(displayName) =>
                                    setEditionEditor((current) =>
                                      current
                                        ? {
                                            ...current,
                                            displayName,
                                            editionId:
                                              current.isNew && !current.editionId
                                                ? toEditionId(displayName)
                                                : current.editionId,
                                          }
                                        : current
                                    )
                                  }
                                />
                              </div>
                              <div className="pm-field-stack">
                                <p className="pm-field-label">Short name</p>
                                <YucpInput
                                  aria-label="Edition ID"
                                  placeholder="commercial"
                                  isDisabled={!editionEditor.isNew}
                                  value={editionEditor.editionId}
                                  onValueChange={(editionId) =>
                                    setEditionEditor((current) =>
                                      current
                                        ? { ...current, editionId: toEditionId(editionId) }
                                        : current
                                    )
                                  }
                                />
                              </div>
                            </div>
                            <div className="space-y-2">
                              <div className="space-y-1">
                                <p className="text-foreground text-sm font-semibold">
                                  Buyer access
                                </p>
                                <p className="pm-subtle-copy text-xs leading-5">
                                  Select one or more tiers. Leave all tiers clear to include every
                                  buyer of this product.
                                </p>
                              </div>
                              {detailQuery.data.catalogTiers.filter(
                                (tier) => tier.status === 'active'
                              ).length > 0 ? (
                                <div className="grid gap-2 sm:grid-cols-2">
                                  {detailQuery.data.catalogTiers
                                    .filter((tier) => tier.status === 'active')
                                    .map((tier) => (
                                      <label
                                        key={tier._id}
                                        className="pm-muted-panel flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-2"
                                      >
                                        <input
                                          type="checkbox"
                                          className="size-4 shrink-0"
                                          aria-label={tier.displayName}
                                          checked={editionEditor.catalogTierIds.includes(tier._id)}
                                          disabled={saveEditionMutation.isPending}
                                          onChange={() => toggleEditionTier(tier._id)}
                                        />
                                        <span className="min-w-0">
                                          <span className="text-foreground block truncate text-sm font-medium">
                                            {tier.displayName}
                                          </span>
                                          <span className="pm-subtle-copy block truncate text-xs">
                                            {formatProviderLabel(tier.provider)}
                                          </span>
                                        </span>
                                      </label>
                                    ))}
                                </div>
                              ) : (
                                <p className="pm-subtle-copy text-sm">
                                  This product grants access without separate tiers.
                                </p>
                              )}
                            </div>
                            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                              <Button
                                size="sm"
                                variant="secondary"
                                isDisabled={saveEditionMutation.isPending}
                                onPress={() => setEditionEditor(null)}
                              >
                                Cancel
                              </Button>
                              <YucpButton
                                size="sm"
                                isLoading={saveEditionMutation.isPending}
                                isDisabled={
                                  !editionEditor.displayName.trim() ||
                                  !editionEditor.editionId.trim()
                                }
                                onPress={() => saveEditionMutation.mutate()}
                              >
                                {saveEditionMutation.isPending
                                  ? editionEditor.isNew
                                    ? 'Creating edition...'
                                    : 'Saving edition...'
                                  : editionEditor.isNew
                                    ? 'Create edition'
                                    : 'Save edition'}
                              </YucpButton>
                            </div>
                          </div>
                        ) : null}

                        <div className="space-y-2">
                          <div className="pm-muted-panel flex flex-col gap-3 rounded-xl p-3 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-foreground text-sm font-medium">Standard</p>
                                <Chip size="sm" variant="soft">
                                  Default
                                </Chip>
                              </div>
                            </div>
                          </div>
                          {detailQuery.data.packageEditions
                            ?.filter((edition) => edition.editionId !== 'standard')
                            .map((edition) => {
                              const tierNames = edition.catalogTierIds
                                .map(
                                  (tierId) =>
                                    detailQuery.data.catalogTiers.find(
                                      (tier) => tier._id === tierId
                                    )?.displayName
                                )
                                .filter((name): name is string => Boolean(name));
                              const isArchiving =
                                archiveEditionMutation.isPending &&
                                archiveEditionMutation.variables === edition.editionId;
                              return (
                                <div
                                  key={edition.editionId}
                                  className="pm-muted-panel space-y-3 rounded-xl p-3"
                                >
                                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                      <div className="flex flex-wrap items-center gap-2">
                                        <p className="text-foreground text-sm font-medium">
                                          {edition.displayName}
                                        </p>
                                        {edition.status === 'archived' ? (
                                          <Chip size="sm" variant="soft">
                                            Archived
                                          </Chip>
                                        ) : null}
                                      </div>
                                      <p className="pm-subtle-copy mt-1 text-xs">
                                        {tierNames.length > 0
                                          ? tierNames.join(', ')
                                          : 'All buyers of this product'}
                                      </p>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        isDisabled={
                                          saveEditionMutation.isPending ||
                                          archiveEditionMutation.isPending
                                        }
                                        aria-label={`Edit edition ${edition.displayName}`}
                                        onPress={() => openEditionEditor(edition)}
                                      >
                                        Edit
                                      </Button>
                                      {edition.status === 'active' ? (
                                        <HoldConfirmButton
                                          accessibleLabel={`Hold to archive edition ${edition.displayName}`}
                                          confirmLabel="Keep holding to archive..."
                                          isDisabled={
                                            saveEditionMutation.isPending ||
                                            (archiveEditionMutation.isPending && !isArchiving)
                                          }
                                          isPending={isArchiving}
                                          onConfirm={() =>
                                            archiveEditionMutation.mutate(edition.editionId)
                                          }
                                          pendingLabel="Archiving..."
                                        >
                                          Archive
                                        </HoldConfirmButton>
                                      ) : null}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          {availableEditions
                            .filter((edition) => edition.source === 'catalog-tier')
                            .map((edition) => (
                              <div
                                key={edition.editionId}
                                className="pm-muted-panel flex flex-col gap-3 rounded-xl p-3 sm:flex-row sm:items-center sm:justify-between"
                              >
                                <p className="text-foreground text-sm font-medium">
                                  {edition.displayName}
                                </p>
                                <div className="flex flex-wrap items-center gap-2">
                                  {edition.provider ? (
                                    <Chip size="sm" variant="soft">
                                      {formatProviderLabel(edition.provider)}
                                    </Chip>
                                  ) : null}
                                  <Chip size="sm" variant="soft">
                                    Synced
                                  </Chip>
                                </div>
                              </div>
                            ))}
                        </div>
                      </Card.Content>
                    </Card>

                    <Card className="pm-card rounded-2xl shadow-none">
                      <Card.Header className="flex flex-col gap-3 p-4 pb-2 sm:flex-row sm:items-end sm:justify-between">
                        <div className="space-y-1">
                          <Card.Title>Release history</Card.Title>
                          <Card.Description className="max-w-[52ch]">
                            Review or remove releases for one edition. Shared files remain available
                            while another release needs them.
                          </Card.Description>
                        </div>
                        <Select
                          className="min-w-48"
                          aria-label="Release history edition"
                          value={selectedHistoryEditionId}
                          variant="secondary"
                          onChange={(key) => {
                            const nextEditionId = String(key ?? '');
                            if (nextEditionId) {
                              setSelectedHistoryEditionId(nextEditionId);
                            }
                          }}
                        >
                          <Label>Edition</Label>
                          <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                          </Select.Trigger>
                          <Select.Popover>
                            <ListBox aria-label="Release history editions">
                              {historyEditions.map((edition) => (
                                <ListBox.Item
                                  key={edition.editionId}
                                  id={edition.editionId}
                                  textValue={`${edition.displayName}${
                                    edition.status === 'archived' ? ' archived' : ''
                                  }`}
                                >
                                  {edition.displayName}
                                  {edition.status === 'archived' ? ' (archived)' : ''}
                                  <ListBox.ItemIndicator />
                                </ListBox.Item>
                              ))}
                            </ListBox>
                          </Select.Popover>
                        </Select>
                      </Card.Header>
                      <Card.Content className="space-y-2 p-4 pt-0">
                        {versionHistoryQuery.isPending ? (
                          <output aria-label="Loading release history" className="block space-y-2">
                            <Skeleton className="h-16 w-full rounded-xl" />
                            <Skeleton className="h-16 w-full rounded-xl" />
                          </output>
                        ) : versionHistoryQuery.isError ? (
                          <div className="space-y-2">
                            <AccountInlineError message="Could not load release history." />
                            <Button
                              size="sm"
                              variant="outline"
                              onPress={() => {
                                void versionHistoryQuery.refetch();
                              }}
                            >
                              Retry release history
                            </Button>
                          </div>
                        ) : packageVersions.length ? (
                          packageVersions.map((packageVersion) => {
                            const isDeleting =
                              deleteVersionMutation.isPending &&
                              deleteVersionMutation.variables?.editionId ===
                                selectedHistoryEditionId &&
                              deleteVersionMutation.variables?.versionId ===
                                packageVersion.versionId;
                            return (
                              <div
                                key={packageVersion.versionId}
                                className="pm-muted-panel space-y-3 rounded-xl p-3"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <p className="text-foreground text-sm font-medium">
                                        {packageVersion.version}
                                      </p>
                                      <Chip size="sm" variant="soft">
                                        {getReleaseStateLabel(packageVersion.state)}
                                      </Chip>
                                    </div>
                                    <p className="pm-subtle-copy mt-1 text-xs">
                                      Added{' '}
                                      {new Intl.DateTimeFormat(undefined, {
                                        dateStyle: 'medium',
                                      }).format(new Date(packageVersion.createdAt))}
                                    </p>
                                  </div>
                                  <HoldConfirmButton
                                    accessibleLabel={`Hold to delete release ${packageVersion.version}`}
                                    confirmLabel="Keep holding to delete..."
                                    isDisabled={deleteVersionMutation.isPending && !isDeleting}
                                    isPending={isDeleting}
                                    onConfirm={() =>
                                      deleteVersionMutation.mutate({
                                        editionId: selectedHistoryEditionId,
                                        versionId: packageVersion.versionId,
                                      })
                                    }
                                    pendingLabel="Deleting..."
                                  >
                                    <Icon name="trash" className="size-4" />
                                    Delete
                                  </HoldConfirmButton>
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <p className="pm-subtle-copy text-sm">
                            No releases are available for this edition.
                          </p>
                        )}
                        {versionHistoryQuery.hasNextPage ? (
                          <div className="flex justify-center pt-2">
                            <YucpButton
                              yucp="ghost"
                              size="sm"
                              isLoading={versionHistoryQuery.isFetchingNextPage}
                              onPress={() => {
                                void versionHistoryQuery.fetchNextPage();
                              }}
                            >
                              {versionHistoryQuery.isFetchingNextPage
                                ? 'Loading more releases...'
                                : 'Load more releases'}
                            </YucpButton>
                          </div>
                        ) : null}
                      </Card.Content>
                    </Card>
                  </>
                )}
              </Sheet.Body>
            </Sheet.Dialog>
          </Sheet.Content>
        </Sheet.Backdrop>
      </Sheet>
      <Sheet
        isDetached
        isOpen={isBootstrapDownloadOpen}
        onOpenChange={(nextOpen) => {
          if (!bootstrapDownloadMutation.isPending) {
            setIsBootstrapDownloadOpen(nextOpen);
          }
        }}
      >
        <Sheet.Backdrop variant="blur">
          <Sheet.Content
            className="pm-sheet-content mx-auto max-w-[720px]"
            aria-label="Download bootstrap"
          >
            <Sheet.Dialog className="pm-sheet-dialog" aria-label="Download bootstrap">
              <Sheet.Handle />
              <Sheet.CloseTrigger />
              <Sheet.Header>
                <Sheet.Heading>Download bootstrap</Sheet.Heading>
              </Sheet.Header>
              <Sheet.Body className="space-y-5">
                <div className="space-y-2">
                  <p className="text-foreground text-sm font-semibold">Release target</p>
                  <Segment
                    aria-label="Bootstrap release target"
                    selectedKey={bootstrapDownloadMode}
                    onSelectionChange={(key) => {
                      if (key === 'latest' || key === 'specific') {
                        setBootstrapDownloadMode(key);
                      }
                    }}
                  >
                    <Segment.Item id="latest">Latest</Segment.Item>
                    <Segment.Item id="specific">Specific version</Segment.Item>
                  </Segment>
                  <p className="pm-subtle-copy text-sm leading-6">
                    {bootstrapDownloadMode === 'latest'
                      ? 'Resolves the newest authorized stable release when this bootstrap is imported. It does not subscribe the project to updates.'
                      : selectedBootstrapVersion
                        ? `Pins this bootstrap to ${selectedBootstrapVersion.version}. It will never substitute a newer release.`
                        : 'Choose the exact release this bootstrap should install.'}
                  </p>
                </div>

                <Select
                  aria-label="Bootstrap edition"
                  selectedKey={bootstrapEditionId}
                  onSelectionChange={(key) => {
                    const editionId = key?.toString();
                    if (editionId) {
                      setBootstrapEditionId(editionId);
                      setSelectedBootstrapVersionId(null);
                    }
                  }}
                >
                  <Label>Edition</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox aria-label="Bootstrap editions">
                      {historyEditions
                        .filter((edition) => edition.status === 'active')
                        .map((edition) => (
                          <ListBox.Item
                            key={edition.editionId}
                            id={edition.editionId}
                            textValue={edition.displayName}
                          >
                            {edition.displayName}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                    </ListBox>
                  </Select.Popover>
                </Select>

                {bootstrapVersionsQuery.isPending ? (
                  <output aria-label="Loading bootstrap releases" className="block space-y-3">
                    <Skeleton className="h-16 w-full rounded-xl" />
                    <Skeleton className="h-16 w-full rounded-xl" />
                    <Skeleton className="h-28 w-full rounded-xl" />
                  </output>
                ) : bootstrapVersionsQuery.isError ? (
                  <div className="space-y-3">
                    <AccountInlineError message="Could not load releases for this edition." />
                    <YucpButton
                      yucp="secondary"
                      size="sm"
                      isLoading={bootstrapVersionsQuery.isFetching}
                      onPress={() => void bootstrapVersionsQuery.refetch()}
                    >
                      Retry releases
                    </YucpButton>
                  </div>
                ) : (bootstrapDownloadMode === 'latest'
                    ? stableBootstrapVersions
                    : eligibleBootstrapVersions
                  ).length === 0 ? (
                  <EmptyState className="pm-muted-panel rounded-xl">
                    <EmptyState.Media variant="icon">
                      <Icon name="package" className="size-5" />
                    </EmptyState.Media>
                    <EmptyState.Content>
                      <EmptyState.Title>No eligible SemVer release</EmptyState.Title>
                      <EmptyState.Description>
                        Publish a READY release with a valid semantic version before downloading a
                        bootstrap for this edition.
                      </EmptyState.Description>
                    </EmptyState.Content>
                  </EmptyState>
                ) : (
                  <>
                    {bootstrapDownloadMode === 'specific' ? (
                      <div className="space-y-2">
                        <p className="text-foreground text-sm font-semibold">Version</p>
                        <ListView
                          aria-label="READY package releases"
                          selectionMode="single"
                          selectedKeys={
                            selectedBootstrapVersionId
                              ? new Set([selectedBootstrapVersionId])
                              : new Set()
                          }
                          onSelectionChange={(keys) => {
                            if (keys === 'all') return;
                            const selected = [...keys][0];
                            setSelectedBootstrapVersionId(
                              selected === undefined ? null : selected.toString()
                            );
                          }}
                        >
                          {eligibleBootstrapVersions.map((entry) => (
                            <ListView.Item
                              key={entry.versionId}
                              id={entry.versionId}
                              textValue={`${entry.version} ${bootstrapEditionId}`}
                            >
                              <ListView.ItemContent>
                                <ListView.Title>{entry.version}</ListView.Title>
                                <ListView.Description>
                                  Published{' '}
                                  {new Intl.DateTimeFormat(undefined, {
                                    dateStyle: 'medium',
                                  }).format(new Date(entry.createdAt))}
                                  {' · '}
                                  {historyEditions.find(
                                    (edition) => edition.editionId === bootstrapEditionId
                                  )?.displayName ?? bootstrapEditionId}
                                  {isPrereleaseSemanticVersion(entry.version)
                                    ? ' · Prerelease'
                                    : ''}
                                </ListView.Description>
                              </ListView.ItemContent>
                            </ListView.Item>
                          ))}
                        </ListView>
                        {bootstrapVersionsQuery.hasNextPage ? (
                          <YucpButton
                            yucp="ghost"
                            size="sm"
                            isLoading={bootstrapVersionsQuery.isFetchingNextPage}
                            onPress={() => void bootstrapVersionsQuery.fetchNextPage()}
                          >
                            {bootstrapVersionsQuery.isFetchingNextPage
                              ? 'Loading more versions...'
                              : 'Load more versions'}
                          </YucpButton>
                        ) : null}
                      </div>
                    ) : null}

                    <ItemCardGroup layout="list">
                      <ItemCard>
                        <ItemCard.Icon>
                          <Icon name="package" className="size-5" />
                        </ItemCard.Icon>
                        <ItemCard.Content>
                          <ItemCard.Title>VPM bootstrap</ItemCard.Title>
                          <ItemCard.Description>
                            Import the ZIP through VCC or another VPM-compatible package manager.
                          </ItemCard.Description>
                        </ItemCard.Content>
                        <ItemCard.Action>
                          <YucpButton
                            size="sm"
                            aria-label="Download VPM bootstrap"
                            isLoading={
                              bootstrapDownloadMutation.isPending &&
                              bootstrapDownloadMutation.variables === 'vpm'
                            }
                            isDisabled={
                              bootstrapDownloadMutation.isPending ||
                              (bootstrapDownloadMode === 'specific' && !selectedBootstrapVersionId)
                            }
                            onPress={() => bootstrapDownloadMutation.mutate('vpm')}
                          >
                            {bootstrapDownloadMutation.isPending &&
                            bootstrapDownloadMutation.variables === 'vpm'
                              ? 'Downloading...'
                              : 'Download'}
                          </YucpButton>
                        </ItemCard.Action>
                      </ItemCard>
                      <ItemCard>
                        <ItemCard.Icon>
                          <Icon name="upload" className="size-5" />
                        </ItemCard.Icon>
                        <ItemCard.Content>
                          <ItemCard.Title>Unitypackage bootstrap</ItemCard.Title>
                          <ItemCard.Description>
                            Import directly into an open Unity project to add the importer and
                            review this release.
                          </ItemCard.Description>
                        </ItemCard.Content>
                        <ItemCard.Action>
                          <YucpButton
                            size="sm"
                            aria-label="Download Unitypackage bootstrap"
                            isLoading={
                              bootstrapDownloadMutation.isPending &&
                              bootstrapDownloadMutation.variables === 'unitypackage'
                            }
                            isDisabled={
                              bootstrapDownloadMutation.isPending ||
                              (bootstrapDownloadMode === 'specific' && !selectedBootstrapVersionId)
                            }
                            onPress={() => bootstrapDownloadMutation.mutate('unitypackage')}
                          >
                            {bootstrapDownloadMutation.isPending &&
                            bootstrapDownloadMutation.variables === 'unitypackage'
                              ? 'Downloading...'
                              : 'Download'}
                          </YucpButton>
                        </ItemCard.Action>
                      </ItemCard>
                    </ItemCardGroup>
                  </>
                )}

                <div className="pm-inline-note rounded-xl p-3">
                  <p className="text-foreground text-sm font-medium">Using VCC</p>
                  <p className="pm-subtle-copy mt-1 text-sm leading-6">
                    Selecting a version in VCC installs that exact release. VCC&apos;s Latest option
                    selects the highest published stable SemVer.
                  </p>
                </div>
              </Sheet.Body>
            </Sheet.Dialog>
          </Sheet.Content>
        </Sheet.Backdrop>
      </Sheet>
    </>
  );
}

export function PackageRegistryPanel({ className = 'bento-col-12' }: PackageRegistryPanelProps) {
  const { contains } = useFilter({ sensitivity: 'base' });
  const queryClient = useQueryClient();
  const toast = useToast();
  const {
    canRunPanelQueries,
    markSessionExpired,
    status: dashboardSessionStatus,
  } = useDashboardSession();
  const [initialAcceptedUploadLane] = useState(readAcceptedUploadLane);
  const preparationAbortControllerRef = useRef<AbortController | null>(null);
  const selectedUploadRef = useRef<SelectedUpload | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState(
    initialAcceptedUploadLane?.catalogProductId ?? ''
  );
  const [detailsProductId, setDetailsProductId] = useState<string | null>(null);
  const [editionId, setEditionId] = useState(initialAcceptedUploadLane?.editionId ?? 'standard');
  const [packageId, setPackageId] = useState(initialAcceptedUploadLane?.packageId ?? '');
  const [version, setVersion] = useState(initialAcceptedUploadLane?.version ?? '');
  const [selectedUpload, setSelectedUpload] = useState<SelectedUpload | null>(
    initialAcceptedUploadLane
      ? {
          catalogProductId: initialAcceptedUploadLane.catalogProductId,
          editionId: initialAcceptedUploadLane.editionId,
          fileName: initialAcceptedUploadLane.fileName,
          fileSize: initialAcceptedUploadLane.fileSize,
          packageId: initialAcceptedUploadLane.packageId,
          progress: initialAcceptedUploadLane.progress,
          status: initialAcceptedUploadLane.status,
          versionId: initialAcceptedUploadLane.versionId,
        }
      : null
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [copyingProductId, setCopyingProductId] = useState<string | null>(null);
  selectedUploadRef.current = selectedUpload;

  const productsQuery = useInfiniteQuery({
    queryKey: creatorProductsQueryKey,
    queryFn: ({ pageParam }) =>
      listCreatorPackageProducts({ configured: true, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    enabled: canRunPanelQueries,
    retry: false,
  });
  const pickerQuery = useQuery({
    queryKey: creatorProductPickerQueryKey,
    queryFn: listCreatorPackagePickerProducts,
    enabled: canRunPanelQueries && isUploadOpen,
    retry: false,
  });

  useEffect(() => {
    if (isDashboardAuthError(productsQuery.error)) {
      markSessionExpired();
    }
  }, [markSessionExpired, productsQuery.error]);

  useEffect(() => {
    if (isDashboardAuthError(pickerQuery.error)) {
      markSessionExpired();
    }
  }, [markSessionExpired, pickerQuery.error]);

  useEffect(() => {
    return () => {
      preparationAbortControllerRef.current?.abort();
    };
  }, []);

  const uploadStatus = selectedUpload?.status;
  const processingStepKey =
    uploadStatus && isServerProcessingStatus(uploadStatus) ? uploadStatus : null;
  const [processingElapsedMs, setProcessingElapsedMs] = useState(0);

  useEffect(() => {
    setProcessingElapsedMs(0);
    if (!processingStepKey) {
      return;
    }
    const startedAt = Date.now();
    const interval = setInterval(() => {
      setProcessingElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => clearInterval(interval);
  }, [processingStepKey]);

  useEffect(() => {
    if (dashboardSessionStatus === 'signed_out') {
      uploadLaneStorage()?.removeItem(ACCEPTED_UPLOAD_LANE_STORAGE_KEY);
    }
  }, [dashboardSessionStatus]);

  useEffect(() => {
    const storage = uploadLaneStorage();
    if (!storage) return;
    if (
      selectedUpload?.versionId &&
      selectedUpload.catalogProductId &&
      selectedUpload.editionId &&
      selectedUpload.packageId &&
      isServerProcessingStatus(selectedUpload.status)
    ) {
      const persisted: PersistedAcceptedUploadLane = {
        acceptedAt: readAcceptedUploadLane()?.acceptedAt ?? Date.now(),
        catalogProductId: selectedUpload.catalogProductId,
        editionId: selectedUpload.editionId,
        fileName: selectedUpload.fileName,
        fileSize: selectedUpload.fileSize,
        packageId: selectedUpload.packageId,
        progress: selectedUpload.progress,
        status: selectedUpload.status,
        version,
        versionId: selectedUpload.versionId,
      };
      storage.setItem(ACCEPTED_UPLOAD_LANE_STORAGE_KEY, JSON.stringify(persisted));
      return;
    }
    storage.removeItem(ACCEPTED_UPLOAD_LANE_STORAGE_KEY);
  }, [selectedUpload, version]);

  const products = useMemo(
    () =>
      [...(productsQuery.data?.pages.flatMap((page) => page.data) ?? [])].sort((left, right) =>
        getProductTitle(left).localeCompare(getProductTitle(right))
      ),
    [productsQuery.data]
  );
  const pickerProducts = useMemo(
    () =>
      (pickerQuery.data ?? []).filter((entry) =>
        entry.products.some((product) => product.status === 'active')
      ),
    [pickerQuery.data]
  );
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const filteredProducts = products.filter((product) =>
    getProductSearchText(product).includes(normalizedSearch)
  );
  const selectedPickerEntry = pickerProducts.find((entry) =>
    entry.products.some((product) => product._id === selectedProductId)
  );
  const selectedProduct =
    getPickerProduct(selectedPickerEntry, selectedProductId) ??
    products.find((product) => product._id === selectedProductId) ??
    null;
  const uploadEditionOptions = useMemo(
    () => (selectedProduct ? getCreatorPackageEditionOptions(selectedProduct) : []),
    [selectedProduct]
  );
  const selectedUploadEdition = uploadEditionOptions.find(
    (candidate) => candidate.editionId === editionId
  );

  const uploadMutation = useMutation({
    mutationFn: async () => {
      const normalizedPackageId = packageId.trim();
      const normalizedVersion = version.trim();
      const selectedEditionId = editionId;
      if (!selectedProduct) {
        throw new Error('Choose the product this package belongs to.');
      }
      if (!/^[a-z0-9\-_./:]{1,128}$/.test(normalizedPackageId)) {
        throw new Error(
          'Enter a registered package ID using lowercase letters and package punctuation.'
        );
      }
      if (!isStrictSemanticVersion(normalizedVersion)) {
        throw new Error('Enter a valid semantic version such as 1.2.3 or 1.2.3-beta.1.');
      }
      if (!selectedUpload?.file) {
        throw new Error('Choose a package file.');
      }

      setFormError(null);
      setSelectedUpload((current) =>
        current
          ? {
              ...current,
              editionId: selectedEditionId,
              status: 'uploading',
              progress: 0,
              errorMessage: undefined,
            }
          : current
      );
      const readyProduct = await uploadPackageAndWait({
        ...(selectedUploadEdition?.catalogTierId
          ? { catalogTierId: selectedUploadEdition.catalogTierId }
          : {}),
        editionId: selectedEditionId,
        file: selectedUpload.file,
        packageId: normalizedPackageId,
        version: normalizedVersion,
        catalogProductIds: getPickerCatalogProductIds(selectedPickerEntry, selectedProduct),
        onProgress: (progress) =>
          setSelectedUpload((current) => {
            const roundedProgress = Math.round(progress);
            return current
              ? { ...current, progress: roundedProgress, status: 'uploading' }
              : current;
          }),
        onAuthorized: (versionId) =>
          setSelectedUpload((current) =>
            current
              ? {
                  ...current,
                  catalogProductId: selectedProduct._id,
                  editionId: selectedEditionId,
                  packageId: normalizedPackageId,
                  versionId,
                }
              : current
          ),
        onTransferComplete: (versionId) =>
          setSelectedUpload((current) =>
            current
              ? {
                  ...current,
                  catalogProductId: selectedProduct._id,
                  editionId: selectedEditionId,
                  packageId: normalizedPackageId,
                  progress: 100,
                  status: 'queued',
                  versionId,
                }
              : current
          ),
      }).then((versionId) => {
        preparationAbortControllerRef.current?.abort();
        const controller = new AbortController();
        preparationAbortControllerRef.current = controller;
        return waitForPackageVersionReady(
          selectedProduct._id,
          normalizedPackageId,
          selectedEditionId,
          versionId,
          (progress) =>
            setSelectedUpload((current) =>
              current
                ? {
                    ...current,
                    errorMessage: undefined,
                    estimatedStartAt: progress.estimatedStartAt,
                    queuePosition: progress.queuePosition,
                    status: progress.state,
                  }
                : current
            ),
          controller.signal
        ).finally(() => {
          if (preparationAbortControllerRef.current === controller) {
            preparationAbortControllerRef.current = null;
          }
        });
      });
      if (readyProduct) {
        setSelectedUpload((current) =>
          current
            ? { ...current, status: 'complete', progress: 100, errorMessage: undefined }
            : current
        );
      }
      return readyProduct;
    },
    onSuccess: async (readyProduct) => {
      setFormError(null);
      if (!readyProduct) {
        toast.info('Package received', {
          description: 'Preparation is still in progress. You can check its status at any time.',
        });
        return;
      }
      queryClient.setQueryData(['creator-package-product', readyProduct._id], readyProduct);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: creatorProductsQueryKey }),
        queryClient.invalidateQueries({ queryKey: creatorProductPickerQueryKey }),
      ]);
      toast.success('Package uploaded');
      setDetailsProductId(readyProduct._id);
      setIsUploadOpen(false);
      setIsDetailsOpen(true);
    },
    onError: (error) => {
      if (error instanceof PackageVersionStatusCheckError) {
        const message = error.message;
        if (isDashboardAuthError(error.cause)) {
          markSessionExpired();
        }
        setFormError(message);
        setSelectedUpload((current) =>
          current?.versionId ? { ...current, errorMessage: message } : current
        );
        toast.warning('Status check interrupted', { description: message });
        return;
      }
      if (error instanceof Error && error.name === 'UploadConflictError') {
        void resolveUploadConflict();
        return;
      }
      const message = getFriendlyUploadError(error);
      setFormError(message);
      setSelectedUpload((current) =>
        current ? { ...current, status: 'failed', errorMessage: message } : current
      );
      toast.error('Upload interrupted', { description: message });
    },
  });

  async function resolveUploadConflict(): Promise<void> {
    const upload = selectedUploadRef.current;
    const fallback = () => {
      const message =
        'This package version already exists. Use a new version number, or check the package details.';
      setFormError(message);
      setSelectedUpload((current) =>
        current ? { ...current, status: 'failed', errorMessage: message } : current
      );
      toast.error('Version already exists', { description: message });
    };
    if (!upload?.packageId || !upload.editionId || !upload.versionId) {
      fallback();
      return;
    }
    let status: CreatorPackageVersionStatus;
    try {
      status = await getCreatorPackageVersionStatus(
        upload.packageId,
        upload.editionId,
        upload.versionId
      );
    } catch {
      fallback();
      return;
    }
    const state = status.state;
    if (isServerProcessingStatus(state)) {
      setFormError(null);
      setSelectedUpload((current) =>
        current ? { ...current, progress: 100, status: state, errorMessage: undefined } : current
      );
      toast.info('Already in progress', {
        description:
          'An earlier upload of this version is still being prepared. Watching it instead.',
      });
      return;
    }
    if (status.state === 'ready') {
      setSelectedUpload((current) =>
        current
          ? { ...current, progress: 100, status: 'complete', errorMessage: undefined }
          : current
      );
      setFormError(null);
      toast.success('Version already published', {
        description: 'This version finished earlier and is available to buyers.',
      });
      return;
    }
    fallback();
  }

  const preparationStatusMutation = useMutation({
    onMutate: () => {
      setFormError(null);
      setSelectedUpload((current) =>
        current?.versionId ? { ...current, errorMessage: undefined } : current
      );
    },
    mutationFn: async () => {
      const upload = selectedUpload;
      if (
        !upload?.catalogProductId ||
        !upload.editionId ||
        !upload.packageId ||
        !upload.versionId ||
        !isServerProcessingStatus(upload.status)
      ) {
        throw new Error('This package has no preparation status to check.');
      }
      preparationAbortControllerRef.current?.abort();
      const controller = new AbortController();
      preparationAbortControllerRef.current = controller;
      return await waitForPackageVersionReady(
        upload.catalogProductId,
        upload.packageId,
        upload.editionId,
        upload.versionId,
        (progress) =>
          setSelectedUpload((current) =>
            current && current.versionId === upload.versionId
              ? {
                  ...current,
                  errorMessage: undefined,
                  estimatedStartAt: progress.estimatedStartAt,
                  queuePosition: progress.queuePosition,
                  status: progress.state,
                }
              : current
          ),
        controller.signal
      ).finally(() => {
        if (preparationAbortControllerRef.current === controller) {
          preparationAbortControllerRef.current = null;
        }
      });
    },
    onSuccess: async (readyProduct) => {
      setFormError(null);
      if (!readyProduct) {
        toast.info('Preparation continues', {
          description: 'The package is safe on the server. Check again later.',
        });
        return;
      }
      setSelectedUpload((current) =>
        current
          ? { ...current, status: 'complete', progress: 100, errorMessage: undefined }
          : current
      );
      queryClient.setQueryData(['creator-package-product', readyProduct._id], readyProduct);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: creatorProductsQueryKey }),
        queryClient.invalidateQueries({ queryKey: creatorProductPickerQueryKey }),
      ]);
      toast.success('Package ready');
      setDetailsProductId(readyProduct._id);
      setIsUploadOpen(false);
      setIsDetailsOpen(true);
    },
    onError: (error) => {
      if (error instanceof PackageVersionStatusCheckError) {
        const message = error.message;
        if (isDashboardAuthError(error.cause)) {
          markSessionExpired();
        }
        setFormError(message);
        setSelectedUpload((current) =>
          current?.versionId ? { ...current, errorMessage: message } : current
        );
        toast.warning('Status check interrupted', { description: message });
        return;
      }
      const message =
        error instanceof Error ? error.message : 'We could not check this package version.';
      setFormError(message);
      setSelectedUpload((current) =>
        current ? { ...current, status: 'failed', errorMessage: message } : current
      );
      toast.error('Could not prepare package', { description: message });
    },
  });

  const resumedVersionIdRef = useRef<string | null>(null);
  const resumeStatusWatch = preparationStatusMutation.mutate;
  const resumableVersionId =
    canRunPanelQueries &&
    !uploadMutation.isPending &&
    !preparationStatusMutation.isPending &&
    selectedUpload?.versionId &&
    selectedUpload.catalogProductId &&
    selectedUpload.editionId &&
    selectedUpload.packageId &&
    isServerProcessingStatus(selectedUpload.status)
      ? selectedUpload.versionId
      : null;

  useEffect(() => {
    if (!resumableVersionId || resumedVersionIdRef.current === resumableVersionId) return;
    resumedVersionIdRef.current = resumableVersionId;
    resumeStatusWatch();
  }, [resumableVersionId, resumeStatusWatch]);

  function openUpload(product?: CreatorPackageProductSummary) {
    const hasDraft = Boolean(
      selectedProductId ||
        editionId !== 'standard' ||
        packageId.trim() ||
        version.trim() ||
        selectedUpload ||
        formError
    );
    if (uploadMutation.isPending || (hasDraft && (!product || product._id === selectedProductId))) {
      setIsUploadOpen(true);
      return;
    }
    setSelectedProductId(product?._id ?? '');
    setEditionId('standard');
    setPackageId(product?.packageId ?? '');
    setVersion('');
    setSelectedUpload(null);
    setFormError(null);
    setIsDetailsOpen(false);
    setIsUploadOpen(true);
  }

  function resetUploadDraft(): void {
    if (uploadMutation.isPending) return;
    setSelectedProductId('');
    setEditionId('standard');
    setPackageId('');
    setVersion('');
    setSelectedUpload(null);
    setFormError(null);
  }

  function selectUploadFile(file: File | null) {
    if (!file) {
      setSelectedUpload(null);
      return;
    }
    if (!isSupportedPackageFileName(file.name)) {
      const message = 'Choose a .unitypackage, .zip, or .spp file.';
      setFormError(message);
      toast.error('Unsupported package file', { description: message });
      return;
    }
    setFormError(null);
    setSelectedUpload({
      file,
      fileName: file.name,
      fileSize: file.size,
      progress: 0,
      status: 'ready',
    });
  }

  async function handleDrop(event: {
    items: Array<{ kind: string; getFile?: () => Promise<File> }>;
  }) {
    for (const item of event.items) {
      if (item.kind === 'file' && item.getFile) {
        selectUploadFile(await item.getFile());
        return;
      }
    }
  }

  async function copyBuyerAccessLink(product: CreatorPackageProductSummary) {
    setCopyingProductId(product._id);
    const copied = await copyToClipboard(getBuyerAccessUrl(product));
    setCopyingProductId(null);
    if (copied) {
      toast.success('Store-page link copied');
    } else {
      toast.error('Could not copy to clipboard');
    }
  }

  return (
    <section className={className}>
      <div className="flex flex-col gap-4">
        <div className="flex justify-end">
          <Button
            variant="outline"
            className="pm-upload-button rounded-full px-4"
            onPress={() => openUpload()}
          >
            <Icon name="upload" className="size-4" />
            Upload a package
          </Button>
        </div>

        {productsQuery.isError ? (
          <div className="space-y-3">
            <AccountInlineError message="Could not load your products." />
            <YucpButton
              yucp="secondary"
              isLoading={productsQuery.isFetching}
              onPress={() => void productsQuery.refetch()}
            >
              Retry catalog
            </YucpButton>
          </div>
        ) : null}

        {!isUploadOpen &&
        selectedUpload &&
        (selectedUpload.status === 'uploading' ||
          isServerProcessingStatus(selectedUpload.status) ||
          selectedUpload.status === 'failed') ? (
          <Card className="pm-card rounded-2xl shadow-none" aria-live="polite">
            <Card.Content className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-foreground truncate text-sm font-semibold">
                  {getUploadHeadline(selectedUpload)}
                </p>
                <p className="pm-subtle-copy mt-1 text-sm">
                  {getUploadSupportingCopy(selectedUpload)}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onPress={() => setIsUploadOpen(true)}
              >
                View upload
              </Button>
            </Card.Content>
          </Card>
        ) : null}

        {productsQuery.isPending ? (
          <PackageRegistryWorkspaceSkeleton
            showHeader={false}
            className="w-full min-w-0"
            listRows={4}
          />
        ) : !productsQuery.isError ? (
          <Card className="pm-card pm-primary-panel rounded-2xl shadow-none">
            <Card.Header className="p-4 pb-2">
              <Card.Title>Products</Card.Title>
            </Card.Header>
            <Card.Content className="space-y-4 p-4 pt-0">
              {products.length > 0 ? (
                <div className="space-y-3">
                  <div className="relative max-w-md">
                    <Icon
                      name="search"
                      className="pm-subtle-copy pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2"
                    />
                    <YucpInput
                      aria-label="Search uploaded products"
                      className="w-full pl-9"
                      placeholder="Find a product"
                      value={searchQuery}
                      onValueChange={setSearchQuery}
                    />
                  </div>
                  {filteredProducts.map((product) => (
                    <ProductRow
                      key={product._id}
                      product={product}
                      isCopying={copyingProductId === product._id}
                      onCopyAccessLink={() => void copyBuyerAccessLink(product)}
                      onOpenDetails={() => {
                        setDetailsProductId(product._id);
                        setIsDetailsOpen(true);
                      }}
                      onUpload={() => openUpload(product)}
                    />
                  ))}
                  {filteredProducts.length === 0 ? (
                    <p className="pm-muted-panel pm-subtle-copy rounded-2xl p-4 text-sm">
                      No products match that search.
                    </p>
                  ) : null}
                </div>
              ) : (
                <EmptyState className="pm-empty-state rounded-2xl border border-dashed">
                  <EmptyState.Header>
                    <EmptyState.Media variant="icon">
                      <Icon name="store" />
                    </EmptyState.Media>
                    <EmptyState.Title>No products available for upload</EmptyState.Title>
                    <EmptyState.Description>
                      Connect a supported store and sync its catalog, then return here to upload the
                      first or next package version.
                    </EmptyState.Description>
                  </EmptyState.Header>
                </EmptyState>
              )}
              {productsQuery.hasNextPage ? (
                <div className="flex justify-center">
                  <YucpButton
                    yucp="secondary"
                    isLoading={productsQuery.isFetchingNextPage}
                    onPress={() => void productsQuery.fetchNextPage()}
                  >
                    {productsQuery.isFetchingNextPage ? 'Loading more...' : 'Load more packages'}
                  </YucpButton>
                </div>
              ) : null}
            </Card.Content>
          </Card>
        ) : null}
      </div>

      <ProductDetailsSheet
        catalogProductId={detailsProductId}
        isOpen={isDetailsOpen}
        onOpenChange={setIsDetailsOpen}
        onUpload={openUpload}
      />

      <Sheet isDetached isOpen={isUploadOpen} onOpenChange={setIsUploadOpen}>
        <Sheet.Backdrop variant="blur">
          <Sheet.Content
            className="pm-sheet-content mx-auto max-w-[680px]"
            aria-label="Upload a package"
          >
            <Sheet.Dialog className="pm-sheet-dialog" aria-label="Upload a package">
              <Sheet.Handle />
              <Sheet.CloseTrigger />
              <Sheet.Header className="pm-sheet-header">
                <Sheet.Heading>Upload a package</Sheet.Heading>
              </Sheet.Header>
              <Sheet.Body className="pm-publish-sheet-body space-y-5">
                <div className="pm-sheet-section space-y-4 rounded-[20px] p-4">
                  {pickerQuery.isPending ? (
                    <Skeleton aria-label="Loading products" className="h-11 w-full rounded-xl" />
                  ) : pickerQuery.isError ? (
                    <div className="space-y-3">
                      <AccountInlineError message="Failed to load products available for upload." />
                      <YucpButton
                        yucp="secondary"
                        isLoading={pickerQuery.isFetching}
                        onPress={() => void pickerQuery.refetch()}
                      >
                        Retry products
                      </YucpButton>
                    </div>
                  ) : pickerProducts.length === 0 ? (
                    <p className="pm-muted-panel pm-subtle-copy rounded-xl p-3 text-sm">
                      No active products are available for upload.
                    </p>
                  ) : (
                    <Autocomplete
                      className="pm-package-picker w-full"
                      placeholder="Choose a product"
                      selectionMode="single"
                      value={selectedPickerEntry?.identityKey ?? null}
                      onChange={(key) => {
                        const entry = pickerProducts.find(
                          (candidate) => candidate.identityKey === String(key ?? '')
                        );
                        const product = getPickerProduct(entry);
                        setSelectedProductId(product?._id ?? '');
                        setEditionId('standard');
                        setPackageId(product?.packageId ?? '');
                      }}
                      onClear={() => {
                        setSelectedProductId('');
                        setEditionId('standard');
                        setPackageId('');
                      }}
                    >
                      <Label className="sr-only">Product</Label>
                      <Autocomplete.Trigger>
                        <Autocomplete.Value />
                        <Autocomplete.ClearButton />
                        <Autocomplete.Indicator />
                      </Autocomplete.Trigger>
                      <DialogContext.Provider value={{ 'aria-label': 'Choose a product' }}>
                        <Autocomplete.Popover className="pm-package-picker-popover">
                          <Heading className="sr-only" slot="title">
                            Choose a product
                          </Heading>
                          <Autocomplete.Filter filter={contains}>
                            <SearchField
                              autoFocus
                              name="package-product-search"
                              variant="secondary"
                            >
                              <Label className="sr-only">Search products</Label>
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
                              aria-label="Products available for upload"
                              renderEmptyState={() => (
                                <div className="pm-subtle-copy px-3 py-2 text-sm">
                                  No products match that search.
                                </div>
                              )}
                            >
                              {pickerProducts.map((entry) => {
                                const product = getPickerProduct(entry);
                                if (!product) return null;
                                return (
                                  <ListBox.Item
                                    key={entry.identityKey}
                                    id={entry.identityKey}
                                    textValue={entry.products.map(getProductSearchText).join(' ')}
                                  >
                                    <div className="flex flex-col">
                                      <span>{getProductTitle(product)}</span>
                                      <span className="pm-subtle-copy text-xs">
                                        {getPickerContextLabel(entry)}
                                      </span>
                                    </div>
                                    <ListBox.ItemIndicator />
                                  </ListBox.Item>
                                );
                              })}
                            </ListBox>
                          </Autocomplete.Filter>
                        </Autocomplete.Popover>
                      </DialogContext.Provider>
                    </Autocomplete>
                  )}
                </div>

                <div className="pm-sheet-section space-y-4 rounded-[20px] p-4">
                  <Select
                    className="w-full"
                    aria-label="Package edition"
                    isDisabled={uploadMutation.isPending || !selectedProduct}
                    value={editionId}
                    onChange={(key) => setEditionId(String(key ?? 'standard'))}
                    variant="secondary"
                  >
                    <Label>Package edition</Label>
                    <Select.Trigger>
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox aria-label="Package editions">
                        {uploadEditionOptions.map((edition) => (
                          <ListBox.Item
                            key={edition.editionId}
                            id={edition.editionId}
                            textValue={`${edition.displayName} ${edition.provider ?? ''}`}
                          >
                            <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                              <span className="truncate">{edition.displayName}</span>
                              {edition.provider ? (
                                <span className="text-muted text-xs">
                                  {formatProviderLabel(edition.provider)}
                                </span>
                              ) : null}
                            </div>
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                  <div className="pm-form-grid">
                    <div className="pm-field-stack">
                      <p className="pm-field-label">Registered install ID</p>
                      <YucpInput
                        aria-label="Install ID"
                        placeholder="com.yourname.product"
                        value={packageId}
                        onValueChange={setPackageId}
                      />
                    </div>
                    <div className="pm-field-stack">
                      <p className="pm-field-label">Release label</p>
                      <YucpInput
                        aria-label="Release label"
                        placeholder="1.0.0"
                        value={version}
                        onValueChange={setVersion}
                      />
                    </div>
                  </div>
                </div>

                <div className="pm-sheet-section space-y-4 rounded-[20px] p-4">
                  <div className="pm-field-stack">
                    <p className="pm-field-label">Package file</p>
                    <p className="pm-subtle-copy text-sm">
                      Choose a `.unitypackage`, `.zip`, or `.spp`. Large files resume automatically
                      if the connection drops.
                    </p>
                    <DropZone className="pm-upload-dropzone w-full">
                      <DropZone.Area onDrop={handleDrop as never}>
                        <DropZone.Icon>
                          <Icon name="package" className="text-accent size-8" />
                        </DropZone.Icon>
                        <DropZone.Label>Drop the package file here</DropZone.Label>
                        <DropZone.Description>
                          Or choose it from your computer.
                        </DropZone.Description>
                        <DropZone.Trigger isDisabled={uploadMutation.isPending}>
                          Choose package file
                        </DropZone.Trigger>
                      </DropZone.Area>
                      <DropZone.Input
                        accept={PACKAGE_FILE_ACCEPT}
                        aria-label="Choose package file"
                        onSelect={(files) => selectUploadFile(files.item(0))}
                      />

                      {selectedUpload ? (
                        <DropZone.FileList>
                          <DropZone.FileItem
                            status={
                              selectedUpload.status === 'ready'
                                ? 'complete'
                                : isServerProcessingStatus(selectedUpload.status)
                                  ? 'uploading'
                                  : selectedUpload.status
                            }
                          >
                            <DropZone.FileFormatIcon
                              color={getPackageFilePresentation(selectedUpload.fileName).color}
                              format={getPackageFilePresentation(selectedUpload.fileName).format}
                            />
                            <DropZone.FileInfo>
                              <DropZone.FileName>{selectedUpload.fileName}</DropZone.FileName>
                              <DropZone.FileMeta>
                                {formatFileSize(selectedUpload.fileSize)}
                                {selectedUpload.status === 'ready' ? ' · Ready to upload' : ''}
                              </DropZone.FileMeta>
                            </DropZone.FileInfo>
                            <DropZone.FileRemoveTrigger
                              aria-label={`Remove ${selectedUpload.fileName}`}
                              isDisabled={
                                uploadMutation.isPending || Boolean(selectedUpload.versionId)
                              }
                              onPress={() => setSelectedUpload(null)}
                            />
                          </DropZone.FileItem>
                        </DropZone.FileList>
                      ) : null}
                    </DropZone>
                    {selectedUpload ? (
                      <UploadStatusAlert elapsedMs={processingElapsedMs} upload={selectedUpload} />
                    ) : null}
                  </div>
                </div>

                {formError ? <AccountInlineError message={formError} /> : null}
              </Sheet.Body>
              <Sheet.Footer className="pm-sheet-footer">
                <Sheet.Close>
                  <Button variant="secondary">
                    {uploadMutation.isPending ? 'Close' : 'Cancel'}
                  </Button>
                </Sheet.Close>
                {selectedUpload?.status === 'complete' ? (
                  <Button variant="outline" onPress={resetUploadDraft}>
                    Upload another version
                  </Button>
                ) : selectedUpload?.versionId &&
                  (isServerProcessingStatus(selectedUpload.status) ||
                    selectedUpload.status === 'failed') &&
                  !uploadMutation.isPending ? (
                  <>
                    {selectedUpload.file ? (
                      <YucpButton
                        isLoading={uploadMutation.isPending}
                        isDisabled={preparationStatusMutation.isPending}
                        onPress={() => uploadMutation.mutate()}
                      >
                        <Icon name="upload" className="size-4" />
                        Retry upload
                      </YucpButton>
                    ) : null}
                    <YucpButton
                      yucp={selectedUpload.file ? 'secondary' : 'primary'}
                      isLoading={preparationStatusMutation.isPending}
                      isDisabled={preparationStatusMutation.isPending}
                      onPress={() => preparationStatusMutation.mutate()}
                    >
                      <Icon name="refresh" className="size-4" />
                      {preparationStatusMutation.isPending
                        ? 'Checking package status...'
                        : 'Check package status'}
                    </YucpButton>
                  </>
                ) : (
                  <YucpButton
                    isLoading={uploadMutation.isPending}
                    isDisabled={
                      uploadMutation.isPending ||
                      !selectedProduct ||
                      !packageId.trim() ||
                      !version.trim() ||
                      !selectedUpload?.file
                    }
                    onPress={() => uploadMutation.mutate()}
                  >
                    <Icon name="upload" className="size-4" />
                    {uploadMutation.isPending
                      ? selectedUpload?.status === 'uploading'
                        ? 'Uploading package...'
                        : 'Preparing package...'
                      : selectedUpload?.versionId && isServerProcessingStatus(selectedUpload.status)
                        ? 'Finishing package...'
                        : selectedUpload?.status === 'failed'
                          ? 'Retry upload'
                          : 'Upload package'}
                  </YucpButton>
                )}
              </Sheet.Footer>
            </Sheet.Dialog>
          </Sheet.Content>
        </Sheet.Backdrop>
      </Sheet>
    </section>
  );
}
