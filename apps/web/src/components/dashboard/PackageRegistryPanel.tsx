import { Button, Card, Chip, ListBox, Select, Skeleton } from '@heroui/react';
import { DropZone, EmptyState, Sheet } from '@heroui-pro/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpFromLine, Copy, Link2, Package2, Search, Store } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AccountInlineError } from '@/components/account/AccountPage';
import { PackageRegistryWorkspaceSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { YucpInput } from '@/components/ui/YucpInput';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import { getAccountProviderIconPath } from '@/lib/account';
import {
  type CreatorPackageProductSummary,
  getCreatorPackageProduct,
  listCreatorPackageProducts,
} from '@/lib/packages';
import { buildBuyerProductAccessPath } from '@/lib/productAccess';
import { uploadPackageFile } from '@/lib/upload';
import { copyToClipboard } from '@/lib/utils';

interface PackageRegistryPanelProps {
  className?: string;
  description?: string;
  title?: string;
}

type SelectedUpload = {
  file: File;
  progress: number;
  status: 'ready' | 'uploading' | 'complete' | 'failed';
  errorMessage?: string;
};

const creatorProductsQueryKey = ['creator-package-products'] as const;
const PACKAGE_FILE_ACCEPT = '.unitypackage,.zip,application/octet-stream,application/zip';

function formatProviderLabel(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
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
    ...(product.aliases ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

function getBuyerAccessUrl(catalogProductId: string): string {
  const path = buildBuyerProductAccessPath(catalogProductId);
  return typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
}

function uploadPackageAndWait(input: {
  file: File;
  packageId: string;
  version: string;
  catalogProductId: string;
  onProgress: (progress: number) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    void uploadPackageFile({
      ...input,
      onSuccess: resolveOnce,
      onError: rejectOnce,
    }).catch((error: unknown) => {
      rejectOnce(error instanceof Error ? error : new Error('Package upload failed'));
    });
  });
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
              <Store className="size-5" aria-hidden="true" />
            )}
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-foreground min-w-0 truncate text-sm font-semibold leading-6 group-hover:underline">
                {getProductTitle(product)}
              </p>
              <Chip size="sm" variant="soft">
                {formatProviderLabel(product.provider)}
              </Chip>
              {isArchived ? (
                <Chip size="sm" variant="soft">
                  Hidden
                </Chip>
              ) : null}
            </div>
            <p className="pm-copy break-all text-sm leading-6">
              {product.providerProductRef} · Catalog product ready for a package upload
            </p>
          </div>
        </button>
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <YucpButton yucp="ghost" size="sm" isLoading={isCopying} onPress={onCopyAccessLink}>
            <Copy className="size-4" aria-hidden="true" />
            {isCopying ? 'Copying...' : 'Copy store-page link'}
          </YucpButton>
          {!isArchived ? (
            <Button size="sm" variant="outline" onPress={onUpload}>
              <ArrowUpFromLine className="size-4" aria-hidden="true" />
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
  const detailQuery = useQuery({
    queryKey: ['creator-package-product', catalogProductId],
    queryFn: () => getCreatorPackageProduct(catalogProductId ?? ''),
    enabled: canRunPanelQueries && isOpen && Boolean(catalogProductId),
    retry: false,
  });

  useEffect(() => {
    if (isDashboardAuthError(detailQuery.error)) {
      markSessionExpired();
    }
  }, [detailQuery.error, markSessionExpired]);

  return (
    <Sheet isOpen={isOpen} onOpenChange={onOpenChange}>
      <Sheet.Backdrop variant="blur">
        <Sheet.Content className="pm-sheet-content mx-auto max-h-[94vh] max-w-[760px]">
          <Sheet.Dialog className="pm-sheet-dialog">
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
                          <p className="pm-subtle-copy break-all text-sm">
                            {formatProviderLabel(detailQuery.data.provider)} ·{' '}
                            {detailQuery.data.providerProductRef}
                          </p>
                        </div>
                        {detailQuery.data.status === 'active' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onPress={() => onUpload(detailQuery.data)}
                          >
                            <ArrowUpFromLine className="size-4" aria-hidden="true" />
                            Upload update
                          </Button>
                        ) : (
                          <Chip size="sm" variant="soft">
                            Hidden
                          </Chip>
                        )}
                      </div>
                      <div className="pm-inline-note rounded-[18px] p-3">
                        <p className="text-foreground text-sm font-semibold">Store-page link</p>
                        <p className="pm-subtle-copy mt-1 break-all text-sm leading-6">
                          {getBuyerAccessUrl(detailQuery.data._id)}
                        </p>
                      </div>
                    </Card.Content>
                  </Card>

                  <Card className="pm-card rounded-2xl shadow-none">
                    <Card.Header className="p-4 pb-2">
                      <p className="text-foreground text-sm font-semibold">Synced access tiers</p>
                    </Card.Header>
                    <Card.Content className="space-y-2 p-4 pt-0">
                      {detailQuery.data.catalogTiers.length > 0 ? (
                        detailQuery.data.catalogTiers.map((tier) => (
                          <div key={tier._id} className="pm-muted-panel rounded-xl p-3">
                            <p className="text-foreground text-sm font-medium">
                              {tier.displayName}
                            </p>
                            <p className="pm-subtle-copy mt-1 text-xs">
                              {tier.status === 'active' ? 'Active' : 'Archived'} ·{' '}
                              {tier.providerTierRef}
                            </p>
                          </div>
                        ))
                      ) : (
                        <p className="pm-subtle-copy text-sm">
                          This product grants access at the product level.
                        </p>
                      )}
                    </Card.Content>
                  </Card>
                </>
              )}
            </Sheet.Body>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
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
  const [searchQuery, setSearchQuery] = useState('');
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [detailsProductId, setDetailsProductId] = useState<string | null>(null);
  const [packageId, setPackageId] = useState('');
  const [version, setVersion] = useState('');
  const [selectedUpload, setSelectedUpload] = useState<SelectedUpload | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [copyingProductId, setCopyingProductId] = useState<string | null>(null);

  const productsQuery = useQuery({
    queryKey: creatorProductsQueryKey,
    queryFn: listCreatorPackageProducts,
    enabled: canRunPanelQueries,
    retry: false,
  });

  useEffect(() => {
    if (isDashboardAuthError(productsQuery.error)) {
      markSessionExpired();
    }
  }, [markSessionExpired, productsQuery.error]);

  const products = useMemo(
    () =>
      [...(productsQuery.data ?? [])].sort((left, right) =>
        getProductTitle(left).localeCompare(getProductTitle(right))
      ),
    [productsQuery.data]
  );
  const activeProducts = products.filter((product) => product.status === 'active');
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const filteredProducts = products.filter((product) =>
    getProductSearchText(product).includes(normalizedSearch)
  );
  const selectedProduct = products.find((product) => product._id === selectedProductId) ?? null;

  const uploadMutation = useMutation({
    mutationFn: async () => {
      const normalizedPackageId = packageId.trim();
      const normalizedVersion = version.trim();
      if (!selectedProduct) {
        throw new Error('Choose the catalog product this package belongs to.');
      }
      if (!/^[a-z0-9\-_./:]{1,128}$/.test(normalizedPackageId)) {
        throw new Error(
          'Enter a registered package ID using lowercase letters and package punctuation.'
        );
      }
      if (!normalizedVersion) {
        throw new Error('Enter the package version.');
      }
      if (!selectedUpload?.file) {
        throw new Error('Choose a package file.');
      }

      setSelectedUpload((current) =>
        current
          ? { ...current, status: 'uploading', progress: 0, errorMessage: undefined }
          : current
      );
      await uploadPackageAndWait({
        file: selectedUpload.file,
        packageId: normalizedPackageId,
        version: normalizedVersion,
        catalogProductId: selectedProduct._id,
        onProgress: (progress) =>
          setSelectedUpload((current) =>
            current ? { ...current, progress: Math.round(progress) } : current
          ),
      });
    },
    onSuccess: async () => {
      setSelectedUpload((current) =>
        current ? { ...current, status: 'complete', progress: 100 } : current
      );
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: creatorProductsQueryKey });
      toast.success('Package uploaded', {
        description: 'The desync pipeline is preparing the new version for delivery.',
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Package upload failed.';
      setFormError(message);
      setSelectedUpload((current) =>
        current ? { ...current, status: 'failed', errorMessage: message } : current
      );
      toast.error('Could not upload package', { description: message });
    },
  });

  function openUpload(product?: CreatorPackageProductSummary) {
    setSelectedProductId(
      product?._id ?? (activeProducts.length === 1 ? activeProducts[0]._id : '')
    );
    setPackageId('');
    setVersion('');
    setSelectedUpload(null);
    setFormError(null);
    setIsDetailsOpen(false);
    setIsUploadOpen(true);
  }

  function selectUploadFile(file: File | null) {
    if (!file) {
      setSelectedUpload(null);
      return;
    }
    const normalizedName = file.name.toLocaleLowerCase();
    if (!normalizedName.endsWith('.unitypackage') && !normalizedName.endsWith('.zip')) {
      const message = 'Choose a .unitypackage or .zip file.';
      setFormError(message);
      toast.error('Unsupported package file', { description: message });
      return;
    }
    setFormError(null);
    setSelectedUpload({ file, progress: 0, status: 'ready' });
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
    const copied = await copyToClipboard(getBuyerAccessUrl(product._id));
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
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="max-w-[64ch] space-y-1.5">
            <h2 className="text-foreground text-[2rem] font-semibold leading-tight">{title}</h2>
            <p className="pm-copy text-sm leading-6">{description}</p>
          </div>
          <Button
            variant="outline"
            className="pm-upload-button self-start rounded-full px-4 md:self-auto"
            onPress={() => openUpload()}
          >
            <ArrowUpFromLine className="size-4" aria-hidden="true" />
            Upload a package
          </Button>
        </div>

        {productsQuery.isError ? (
          <div className="space-y-3">
            <AccountInlineError message="Failed to load the creator catalog from the current registry API." />
            <YucpButton
              yucp="secondary"
              isLoading={productsQuery.isFetching}
              onPress={() => void productsQuery.refetch()}
            >
              Retry catalog
            </YucpButton>
          </div>
        ) : null}

        {productsQuery.isPending ? (
          <PackageRegistryWorkspaceSkeleton
            showHeader={false}
            className="w-full min-w-0"
            listRows={4}
          />
        ) : !productsQuery.isError ? (
          <Card className="pm-card pm-primary-panel rounded-2xl shadow-none">
            <Card.Header className="flex flex-col gap-3 p-4 pb-2">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Link2 className="text-primary size-6" aria-hidden="true" />
                  <p className="text-foreground text-lg font-semibold">
                    Products ready for an update
                  </p>
                </div>
                <p className="pm-copy max-w-[52ch] text-sm leading-6">
                  Choose a synced product, upload its new package file, and share the matching YUCP
                  access page with buyers.
                </p>
              </div>
            </Card.Header>
            <Card.Content className="space-y-4 p-4 pt-0">
              <div className="pm-inline-note rounded-[18px] p-3">
                <p className="text-foreground text-sm font-semibold">Customer setup steps</p>
                <p className="pm-subtle-copy mt-1 text-sm leading-6">
                  Share the YUCP access page in your store delivery notes. Buyers sign in, verify
                  their purchase, then add their private repository to VCC.
                </p>
              </div>

              {products.length > 0 ? (
                <div className="space-y-3">
                  <div className="relative max-w-md">
                    <Search className="pm-subtle-copy pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2" />
                    <YucpInput
                      aria-label="Search catalog products"
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
                      No catalog products match that search.
                    </p>
                  ) : null}
                </div>
              ) : (
                <EmptyState className="pm-empty-state rounded-2xl border border-dashed">
                  <EmptyState.Header>
                    <EmptyState.Media variant="icon">
                      <Store />
                    </EmptyState.Media>
                    <EmptyState.Title>No configured packages yet</EmptyState.Title>
                    <EmptyState.Description>
                      Sign a package with the YUCP signing tool to register it. Once registered,
                      return here to upload new versions to that package.
                    </EmptyState.Description>
                  </EmptyState.Header>
                </EmptyState>
              )}
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
          <Sheet.Content className="pm-sheet-content pm-publish-sheet-content mx-auto max-h-[calc(100svh-48px)] max-w-[680px]">
            <Sheet.Dialog className="pm-sheet-dialog">
              <Sheet.Handle />
              <Sheet.CloseTrigger />
              <Sheet.Header className="pm-sheet-header">
                <Sheet.Heading>Upload a package</Sheet.Heading>
                <p className="pm-copy text-sm leading-6">
                  Pick the product, add the file, and send it through resumable storage.
                </p>
              </Sheet.Header>
              <Sheet.Body className="pm-publish-sheet-body space-y-5">
                <div className="pm-sheet-section space-y-4 rounded-[20px] p-4">
                  <div className="space-y-1">
                    <p className="text-foreground text-sm font-semibold">Product</p>
                    <p className="pm-subtle-copy text-sm">
                      The resulting version will be bound to this catalog product for buyer access.
                    </p>
                  </div>
                  <Select
                    aria-label="Catalog product"
                    className="pm-package-picker w-full"
                    placeholder="Choose a product"
                    selectedKey={selectedProductId || null}
                    onSelectionChange={(key) => setSelectedProductId(String(key ?? ''))}
                  >
                    <Select.Trigger>
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover className="pm-package-picker-popover">
                      <ListBox>
                        {activeProducts.map((product) => (
                          <ListBox.Item
                            key={product._id}
                            id={product._id}
                            textValue={getProductSearchText(product)}
                          >
                            <div className="flex flex-col">
                              <span>{getProductTitle(product)}</span>
                              <span className="pm-subtle-copy text-xs">
                                {formatProviderLabel(product.provider)} ·{' '}
                                {product.providerProductRef}
                              </span>
                            </div>
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                </div>

                <div className="pm-sheet-section space-y-4 rounded-[20px] p-4">
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
                      <p className="pm-field-label">Version</p>
                      <YucpInput
                        aria-label="Version"
                        placeholder="1.0.0"
                        value={version}
                        onValueChange={setVersion}
                      />
                    </div>
                  </div>
                  <div className="pm-inline-note rounded-[18px] p-3">
                    <p className="text-foreground text-sm font-semibold">Ownership check</p>
                    <p className="pm-subtle-copy mt-1 text-sm leading-6">
                      Upload authorization verifies this install ID against the package registry and
                      confirms that the selected product belongs to your Creator Identity.
                    </p>
                  </div>
                </div>

                <div className="pm-sheet-section space-y-4 rounded-[20px] p-4">
                  <div className="pm-field-stack">
                    <p className="pm-field-label">Package file</p>
                    <p className="pm-subtle-copy text-sm">
                      Choose a `.unitypackage` or `.zip`. Large files resume automatically if the
                      connection drops.
                    </p>
                    <DropZone className="pm-upload-dropzone w-full">
                      <DropZone.Area onDrop={handleDrop as never}>
                        <DropZone.Icon>
                          <Package2 className="text-accent size-8" aria-hidden="true" />
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
                              selectedUpload.status === 'ready' ? 'complete' : selectedUpload.status
                            }
                          >
                            <DropZone.FileFormatIcon
                              color={selectedUpload.file.name.endsWith('.zip') ? 'orange' : 'blue'}
                              format={selectedUpload.file.name.endsWith('.zip') ? 'ZIP' : 'UNITY'}
                            />
                            <DropZone.FileInfo>
                              <DropZone.FileName>{selectedUpload.file.name}</DropZone.FileName>
                              <DropZone.FileMeta>
                                {formatFileSize(selectedUpload.file.size)} ·{' '}
                                {selectedUpload.status === 'ready'
                                  ? 'Ready to upload'
                                  : selectedUpload.status === 'uploading'
                                    ? `Uploading ${selectedUpload.progress}%`
                                    : selectedUpload.status === 'complete'
                                      ? 'Upload complete'
                                      : 'Upload failed'}
                              </DropZone.FileMeta>
                              {selectedUpload.status === 'uploading' ? (
                                <DropZone.FileProgress value={selectedUpload.progress}>
                                  <DropZone.FileProgressTrack>
                                    <DropZone.FileProgressFill />
                                  </DropZone.FileProgressTrack>
                                </DropZone.FileProgress>
                              ) : null}
                              {selectedUpload.errorMessage ? (
                                <DropZone.FileMeta>{selectedUpload.errorMessage}</DropZone.FileMeta>
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
                </div>

                {formError ? <AccountInlineError message={formError} /> : null}
              </Sheet.Body>
              <Sheet.Footer className="pm-sheet-footer">
                <Sheet.Close>
                  <Button variant="secondary">Cancel</Button>
                </Sheet.Close>
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
                  <ArrowUpFromLine className="size-4" aria-hidden="true" />
                  {uploadMutation.isPending ? 'Uploading package...' : 'Upload package'}
                </YucpButton>
              </Sheet.Footer>
            </Sheet.Dialog>
          </Sheet.Content>
        </Sheet.Backdrop>
      </Sheet>
    </section>
  );
}
