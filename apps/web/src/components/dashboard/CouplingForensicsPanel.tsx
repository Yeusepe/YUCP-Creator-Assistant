import { Autocomplete, Button, Chip, ListBox, SearchField, useFilter } from '@heroui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { DashboardGridSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { useToast } from '@/components/ui/Toast';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import { hasActiveCreatorBillingCapability, listCreatorCertificates } from '@/lib/certificates';
import {
  type CouplingForensicsLookupResponse,
  isCouplingTraceabilityRequiredError,
  listCouplingForensicsPackages,
  revealCouplingLicenseKey,
  runCouplingForensicsLookup,
} from '@/lib/couplingForensics';
import { BILLING_CAPABILITY_KEYS } from '../../../../../convex/lib/billingCapabilities';

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_FORENSICS_UPLOAD_BYTES = 100 * 1024 * 1024;
const SUPPORTED_FORENSICS_UPLOAD_EXTENSIONS = ['.unitypackage', '.zip'] as const;

function getForensicsFileValidationError(file: File): string | null {
  const normalizedName = file.name.trim().toLowerCase();
  const hasSupportedExtension = SUPPORTED_FORENSICS_UPLOAD_EXTENSIONS.some((extension) =>
    normalizedName.endsWith(extension)
  );
  if (!hasSupportedExtension) {
    return 'Unsupported file type. Upload a .unitypackage or .zip file.';
  }
  if (file.size > MAX_FORENSICS_UPLOAD_BYTES) {
    return 'File is too large. Maximum size is 100 MB.';
  }
  return null;
}

function formatBuyerDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function noRetryOn4xx(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

function getVerdictKind(
  status: CouplingForensicsLookupResponse['lookupStatus'],
  buyerCount: number
): 'match' | 'trace_unresolved' | 'tampered' | 'no_match' | 'no_assets' {
  if (status === 'attributed' && buyerCount > 0) return 'match';
  if (status === 'attributed') return 'trace_unresolved';
  if (status === 'tampered_suspected') return 'tampered';
  if (status === 'no_candidate_assets') return 'no_assets';
  return 'no_match';
}

function getBuyerDisplayLabel(match: {
  buyerSubjectDisplayName?: string | null;
  purchaserEmail?: string | null;
  buyerProviderUsername?: string | null;
  buyerProviderUserId?: string | null;
  buyerSubjectDiscordUserId?: string | null;
}) {
  return (
    match.buyerSubjectDisplayName?.trim() ||
    match.purchaserEmail?.trim() ||
    match.buyerProviderUsername?.trim() ||
    match.buyerProviderUserId?.trim() ||
    match.buyerSubjectDiscordUserId?.trim() ||
    null
  );
}

type FxTone = 'success' | 'warning' | 'info' | 'danger';

const VERDICT_CONFIG = {
  trace_unresolved: {
    tone: 'info',
    title: 'Trace found',
    description:
      "This file matches a traced license in your store, but we don't have the original buyer linked to that license yet.",
  },
  tampered: {
    tone: 'warning',
    title: 'Tracking removed',
    description:
      "This file was modified to remove identifying information. We can't trace it to a specific buyer, but the file was tampered with.",
  },
  no_assets: {
    tone: 'info',
    title: 'No trackable files found',
    description:
      "This archive doesn't contain any files that can be traced. Make sure you're uploading the right product.",
  },
  no_match: {
    tone: 'info',
    title: 'No match found',
    description:
      'This file doesn’t match any purchase in your store. It may have come from a different product or platform.',
  },
} as const;

function FxNoteIcon({ tone }: { tone: FxTone }) {
  if (tone === 'success') {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        aria-hidden="true"
      >
        <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (tone === 'warning' || tone === 'danger') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path
          d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <line x1="12" y1="9" x2="12" y2="13" strokeLinecap="round" />
        <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" strokeLinecap="round" />
      <line x1="12" y1="8" x2="12.01" y2="8" strokeLinecap="round" />
    </svg>
  );
}

function FxNote({
  tone,
  title,
  description,
  children,
}: {
  tone: FxTone;
  title?: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`fx-note fx-note--${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <span className="fx-note-icon" aria-hidden="true">
        <FxNoteIcon tone={tone} />
      </span>
      <div className="min-w-0 flex-1">
        {title ? <p className="fx-note-title">{title}</p> : null}
        {description ? <p className="fx-note-desc">{description}</p> : null}
        {children}
      </div>
    </div>
  );
}

function MetaField({
  label,
  children,
  full,
  mono,
}: {
  label: string;
  children: ReactNode;
  full?: boolean;
  mono?: boolean;
}) {
  return (
    <div className={full ? 'sm:col-span-2' : undefined}>
      <dt className="text-muted text-xs font-medium">{label}</dt>
      <dd
        className={`mt-0.5 text-foreground text-sm ${mono ? 'break-all font-mono text-[13px]' : ''}`}
      >
        {children}
      </dd>
    </div>
  );
}

export function CouplingForensicsPanel({ initialPackageId }: { initialPackageId?: string } = {}) {
  const toast = useToast();
  const { isPersonalDashboard } = useActiveDashboardContext();
  const { canRunPanelQueries, isAuthResolved, markSessionExpired, status } = useDashboardSession();
  const { contains } = useFilter({ sensitivity: 'base' });

  const [selectedPackageId, setSelectedPackageId] = useState(initialPackageId ?? '');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [lookupResult, setLookupResult] = useState<CouplingForensicsLookupResponse | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const handleFilePick = (file: File | null): boolean => {
    if (lookupMutation.isPending) return false;
    if (!file) {
      setSelectedFile(null);
      setInlineError(null);
      return true;
    }
    const validationError = getForensicsFileValidationError(file);
    if (validationError) {
      setSelectedFile(null);
      setInlineError(validationError);
      return false;
    }
    setSelectedFile(file);
    setInlineError(null);
    return true;
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    const file = e.dataTransfer.files[0] ?? null;
    if (file) handleFilePick(file);
  };

  const certificatesQuery = useQuery({
    queryKey: ['creator-certificates'],
    queryFn: listCreatorCertificates,
    enabled: canRunPanelQueries && isPersonalDashboard,
    retry: noRetryOn4xx,
  });

  const capabilityEnabled = hasActiveCreatorBillingCapability(
    certificatesQuery.data?.billing.capabilities,
    BILLING_CAPABILITY_KEYS.couplingTraceability
  );

  const packagesQuery = useQuery({
    queryKey: ['coupling-forensics', 'packages'],
    queryFn: listCouplingForensicsPackages,
    enabled: canRunPanelQueries && isPersonalDashboard && capabilityEnabled,
    retry: noRetryOn4xx,
  });

  useEffect(() => {
    if (
      isDashboardAuthError(packagesQuery.error) ||
      isDashboardAuthError(certificatesQuery.error)
    ) {
      markSessionExpired();
    }
  }, [certificatesQuery.error, markSessionExpired, packagesQuery.error]);

  const packageOptions = useMemo(
    () =>
      (packagesQuery.data?.packages ?? []).map((pkg) => ({
        value: pkg.packageId,
        label: pkg.packageName ?? pkg.packageId,
      })),
    [packagesQuery.data?.packages]
  );

  useEffect(() => {
    if (packageOptions.length === 0) {
      if (selectedPackageId) setSelectedPackageId('');
      return;
    }
    if (!packageOptions.some((option) => option.value === selectedPackageId)) {
      setSelectedPackageId(packageOptions[0]?.value ?? '');
    }
  }, [packageOptions, selectedPackageId]);

  // Collect all matches across all matched assets, deduplicated by licenseSubject
  const matchedBuyers = useMemo(() => {
    if (!lookupResult) return [];
    const seen = new Set<string>();
    const buyers: Array<{
      licenseSubject: string;
      createdAt: number;
      correlationId: string | null;
      runtimeArtifactVersion?: string | null;
      runtimePlaintextSha256?: string | null;
      machineFingerprintHash?: string | null;
      projectIdHash?: string | null;
      grantId?: string | null;
      packFamily?: string | null;
      packVersion?: string | null;
      provider?: string | null;
      licenseMasked?: string | null;
      purchaserEmail?: string | null;
      licenseKey?: string | null;
      buyerProviderUserId?: string | null;
      buyerProviderUsername?: string | null;
      buyerSubjectDisplayName?: string | null;
      buyerSubjectDiscordUserId?: string | null;
      buyerDisplayLabel: string;
    }> = [];
    for (const entry of lookupResult.results) {
      if (!entry.matched) continue;
      for (const match of entry.matches) {
        const buyerDisplayLabel = getBuyerDisplayLabel(match);
        if (!buyerDisplayLabel) continue;
        if (!seen.has(match.licenseSubject)) {
          seen.add(match.licenseSubject);
          buyers.push({
            licenseSubject: match.licenseSubject,
            createdAt: match.createdAt,
            correlationId: match.correlationId,
            runtimeArtifactVersion: match.runtimeArtifactVersion,
            runtimePlaintextSha256: match.runtimePlaintextSha256,
            machineFingerprintHash: match.machineFingerprintHash,
            projectIdHash: match.projectIdHash,
            grantId: match.grantId,
            packFamily: match.packFamily,
            packVersion: match.packVersion,
            provider: match.provider,
            licenseMasked: match.licenseMasked,
            purchaserEmail: match.purchaserEmail?.trim() || null,
            licenseKey: match.licenseKey,
            buyerProviderUserId: match.buyerProviderUserId,
            buyerProviderUsername: match.buyerProviderUsername,
            buyerSubjectDisplayName: match.buyerSubjectDisplayName,
            buyerSubjectDiscordUserId: match.buyerSubjectDiscordUserId,
            buyerDisplayLabel,
          });
        }
      }
    }
    return buyers.sort((a, b) => b.createdAt - a.createdAt);
  }, [lookupResult]);

  const [revealedKeys, setRevealedKeys] = useState<Record<string, string>>({});

  const lookupMutation = useMutation({
    mutationFn: ({ packageId, file }: { packageId: string; file: File }) =>
      runCouplingForensicsLookup({ packageId, file }),
    onMutate: () => {
      setInlineError(null);
      setLookupResult(null);
      setRevealedKeys({});
    },
    onSuccess: (result) => {
      setLookupResult(result);
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      if (isCouplingTraceabilityRequiredError(error)) {
        toast.warning('Creator Studio+ required', {
          description: 'Upgrade your creator workspace to use leak tracing.',
        });
        return;
      }
      setInlineError('Scan failed. Please try again with a supported .unitypackage or .zip file.');
    },
  });

  const revealMutation = useMutation({
    mutationFn: ({ licenseSubject }: { licenseSubject: string }) =>
      revealCouplingLicenseKey({
        packageId: lookupResult?.packageId ?? selectedPackageId,
        licenseSubject,
      }),
    onSuccess: (result, variables) => {
      if (result.licenseKey) {
        setRevealedKeys((prev) => ({
          ...prev,
          [variables.licenseSubject]: result.licenseKey as string,
        }));
      }
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      toast.error('Could not reveal license key', {
        description: 'You may not have access, or no key is on file for this license.',
      });
    },
  });

  const isLoading =
    !isAuthResolved || (canRunPanelQueries && isPersonalDashboard && certificatesQuery.isLoading);
  const hasCapabilityQueryError =
    certificatesQuery.isError && !isDashboardAuthError(certificatesQuery.error);
  const hasQueryError = packagesQuery.isError && !isDashboardAuthError(packagesQuery.error);

  const verdictKind = lookupResult
    ? getVerdictKind(lookupResult.lookupStatus, matchedBuyers.length)
    : null;

  /* ── Guards ── */

  if (status === 'signed_out' || status === 'expired') {
    return (
      <div id="tab-panel-forensics" className="dashboard-tab-panel is-active" role="tabpanel">
        <DashboardAuthRequiredState
          id="forensics-auth"
          title="Sign in to trace leaked files"
          description="Your session expired. Sign in again to identify who shared your product."
        />
      </div>
    );
  }

  if (!isPersonalDashboard) {
    return (
      <div id="tab-panel-forensics" className="dashboard-tab-panel is-active" role="tabpanel">
        <div className="bento-grid">
          <section className="intg-card animate-in bento-col-12">
            <div className="intg-header">
              <div className="intg-icon">
                <img
                  src="/Icons/Shield.png"
                  alt=""
                  aria-hidden="true"
                  style={{ width: '22px', height: '22px', objectFit: 'contain' }}
                />
              </div>
              <div className="intg-copy">
                <h1 className="intg-title">Creator scope required</h1>
                <p className="intg-desc">
                  Leak tracing is scoped to your Creator Identity. Open it from your root creator
                  dashboard.
                </p>
              </div>
            </div>
            <Link
              to="/dashboard/packages"
              search={(prev) => ({ ...prev, guild_id: undefined, tenant_id: undefined })}
              className="account-btn account-btn--primary"
              style={{ borderRadius: '999px', alignSelf: 'flex-start' }}
            >
              Switch to creator dashboard
            </Link>
          </section>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div id="tab-panel-forensics" className="dashboard-tab-panel is-active" role="tabpanel">
        <div className="bento-grid">
          <DashboardGridSkeleton cards={3} />
        </div>
      </div>
    );
  }

  /* ── Main ── */

  return (
    <div id="tab-panel-forensics" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        <section className="intg-card animate-in bento-col-12">
          <div className="intg-header">
            <div className="intg-title-row">
              <div className="intg-icon">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 2l7 4v6c0 5-3.2 9.4-7 10-3.8-.6-7-5-7-10V6z" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
              </div>
              <div className="intg-copy">
                <h2 className="intg-title">Leak Tracer</h2>
                <p className="intg-desc">
                  Found a suspicious file? Upload it to find out which buyer it came from.
                </p>
              </div>
            </div>
            <Chip color="accent" variant="soft" size="sm">
              Creator Studio+
            </Chip>
          </div>
          <div className="mt-5 space-y-5">
            {hasQueryError ? (
              <FxNote
                tone="danger"
                title="Couldn’t load your products"
                description="Refresh the page and try again."
              />
            ) : null}
            {inlineError ? <FxNote tone="danger" description={inlineError} /> : null}

            {hasCapabilityQueryError ? (
              <FxNote
                tone="warning"
                title="Could not verify your plan"
                description="Refresh your billing state and try again."
              >
                <Button
                  size="sm"
                  variant="primary"
                  className="mt-3 w-fit"
                  onPress={() => {
                    void certificatesQuery.refetch();
                  }}
                >
                  Retry
                </Button>
              </FxNote>
            ) : certificatesQuery.isSuccess && capabilityEnabled === false ? (
              <FxNote
                tone="info"
                title="Creator Studio+ required"
                description="Leak tracing is available on Creator Studio+. Upgrade to identify buyers who share your files."
              >
                <Link
                  to="/account/billing"
                  className="account-btn account-btn--primary mt-3"
                  style={{ borderRadius: '999px', alignSelf: 'flex-start' }}
                >
                  Upgrade billing
                </Link>
              </FxNote>
            ) : (
              <form
                className="space-y-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!selectedPackageId || !selectedFile) {
                    setInlineError('Choose a product and upload a file to scan.');
                    return;
                  }
                  const validationError = getForensicsFileValidationError(selectedFile);
                  if (validationError) {
                    setSelectedFile(null);
                    setInlineError(validationError);
                    return;
                  }
                  lookupMutation.mutate({ packageId: selectedPackageId, file: selectedFile });
                }}
              >
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="bg-accent text-accent-foreground flex size-5 items-center justify-center rounded-full text-xs font-semibold">
                      1
                    </span>
                    <span className="text-foreground text-sm font-medium">
                      Which product is this file from?
                    </span>
                  </div>
                  <Autocomplete
                    aria-label="Product to scan"
                    className="pm-package-picker w-full max-w-md"
                    placeholder="Choose a product"
                    selectionMode="single"
                    isDisabled={lookupMutation.isPending || packageOptions.length === 0}
                    value={selectedPackageId || null}
                    onChange={(key) => setSelectedPackageId(key ? String(key) : '')}
                    onClear={() => setSelectedPackageId('')}
                  >
                    <Autocomplete.Trigger>
                      <Autocomplete.Value />
                      <Autocomplete.ClearButton />
                      <Autocomplete.Indicator />
                    </Autocomplete.Trigger>
                    <Autocomplete.Popover className="pm-package-picker-popover">
                      <Autocomplete.Filter filter={contains}>
                        <SearchField autoFocus name="forensics-product-search" variant="secondary">
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
                          {packageOptions.map((option) => (
                            <ListBox.Item
                              key={option.value}
                              id={option.value}
                              textValue={option.label}
                            >
                              {option.label}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Autocomplete.Filter>
                    </Autocomplete.Popover>
                  </Autocomplete>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="bg-accent text-accent-foreground flex size-5 items-center justify-center rounded-full text-xs font-semibold">
                      2
                    </span>
                    <span className="text-foreground text-sm font-medium">
                      Upload the suspicious file
                    </span>
                  </div>
                  {selectedFile ? (
                    <div className="fx-pane flex items-center gap-3 p-4">
                      <span className="fx-icon-chip text-muted flex size-10 shrink-0 items-center justify-center rounded-xl">
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-foreground truncate text-sm font-medium">
                          {selectedFile.name}
                        </p>
                        <p className="text-muted text-xs tabular-nums">
                          {formatFileSize(selectedFile.size)}
                        </p>
                      </div>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label="Remove file"
                        isDisabled={lookupMutation.isPending}
                        onPress={() => {
                          if (lookupMutation.isPending) return;
                          handleFilePick(null);
                          if (fileInputRef.current) fileInputRef.current.value = '';
                        }}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          aria-hidden="true"
                        >
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </Button>
                      <input
                        ref={fileInputRef}
                        id="forensics-file"
                        type="file"
                        accept=".unitypackage,.zip"
                        disabled={lookupMutation.isPending}
                        className="hidden"
                        onChange={(e) => {
                          if (lookupMutation.isPending) return;
                          if (!handleFilePick(e.target.files?.[0] ?? null)) {
                            e.currentTarget.value = '';
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <label
                      htmlFor="forensics-file"
                      onDragEnter={handleDragEnter}
                      onDragOver={(e) => e.preventDefault()}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      className={`fx-dropzone flex cursor-[var(--cursor-interactive)] flex-col items-center justify-center gap-2 p-8 text-center ${
                        isDragOver ? 'is-dragover' : ''
                      } ${lookupMutation.isPending ? 'pointer-events-none opacity-60' : ''}`}
                    >
                      <input
                        ref={fileInputRef}
                        id="forensics-file"
                        type="file"
                        accept=".unitypackage,.zip"
                        className="sr-only"
                        disabled={lookupMutation.isPending}
                        onChange={(e) => {
                          if (lookupMutation.isPending) return;
                          if (!handleFilePick(e.target.files?.[0] ?? null)) {
                            e.currentTarget.value = '';
                          }
                        }}
                      />
                      <span className="fx-icon-chip text-muted flex size-11 items-center justify-center rounded-full">
                        <svg
                          width="20"
                          height="20"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="17 8 12 3 7 8" />
                          <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                      </span>
                      <p className="text-foreground text-sm font-medium">
                        {isDragOver ? 'Drop to upload' : 'Click to upload or drag & drop'}
                      </p>
                      <p className="text-muted text-xs">.unitypackage or .zip · max 100 MB</p>
                    </label>
                  )}
                </div>

                <div className="flex justify-end">
                  <Button
                    type="submit"
                    variant="primary"
                    isPending={lookupMutation.isPending}
                    isDisabled={
                      lookupMutation.isPending ||
                      !selectedPackageId ||
                      !selectedFile ||
                      packageOptions.length === 0
                    }
                  >
                    {lookupMutation.isPending ? 'Scanning…' : 'Find buyer'}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </section>

        {/* Results */}
        {lookupResult && verdictKind ? (
          <section className="intg-card animate-in animate-in-delay-1 bento-col-12">
            <div className="space-y-4">
              {verdictKind === 'match' ? (
                <>
                  <FxNote
                    tone="success"
                    title={
                      matchedBuyers.length === 1
                        ? 'Buyer identified'
                        : `${matchedBuyers.length} buyers identified`
                    }
                    description={
                      matchedBuyers.length === 1
                        ? 'This file traces back to the following purchase.'
                        : 'This file traces back to the following purchases.'
                    }
                  />
                  <div className="space-y-3">
                    {matchedBuyers.map((buyer) => (
                      <div key={buyer.licenseSubject} className="fx-pane space-y-3 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-foreground text-sm font-semibold">
                            {buyer.buyerDisplayLabel}
                          </p>
                          {buyer.provider ? (
                            <Chip size="sm" variant="soft" className="capitalize">
                              {buyer.provider}
                            </Chip>
                          ) : null}
                        </div>
                        <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
                          {buyer.buyerSubjectDiscordUserId &&
                          buyer.buyerSubjectDiscordUserId !== buyer.buyerDisplayLabel ? (
                            <MetaField label="Discord">{buyer.buyerSubjectDiscordUserId}</MetaField>
                          ) : null}

                          {(buyer.buyerProviderUsername || buyer.buyerProviderUserId) &&
                          (buyer.buyerProviderUsername ?? buyer.buyerProviderUserId) !==
                            buyer.buyerDisplayLabel ? (
                            <MetaField label="Store account">
                              {buyer.buyerProviderUsername ?? buyer.buyerProviderUserId}
                            </MetaField>
                          ) : null}

                          <MetaField label="Trace recorded">
                            {formatBuyerDate(buyer.createdAt)}
                          </MetaField>

                          {buyer.licenseMasked ||
                          buyer.licenseKey ||
                          revealedKeys[buyer.licenseSubject] ? (
                            <MetaField label="License" full mono>
                              {(revealedKeys[buyer.licenseSubject] ?? buyer.licenseKey) ? (
                                (revealedKeys[buyer.licenseSubject] ?? buyer.licenseKey)
                              ) : (
                                <span className="inline-flex flex-wrap items-center gap-2">
                                  <span>{buyer.licenseMasked}</span>
                                  <Button
                                    size="sm"
                                    variant="primary"
                                    isPending={
                                      revealMutation.isPending &&
                                      revealMutation.variables?.licenseSubject ===
                                        buyer.licenseSubject
                                    }
                                    isDisabled={revealMutation.isPending}
                                    onPress={() =>
                                      revealMutation.mutate({
                                        licenseSubject: buyer.licenseSubject,
                                      })
                                    }
                                  >
                                    Reveal key
                                  </Button>
                                </span>
                              )}
                            </MetaField>
                          ) : null}

                          {buyer.runtimeArtifactVersion ? (
                            <MetaField label="Package version" mono>
                              {buyer.runtimeArtifactVersion}
                            </MetaField>
                          ) : null}

                          {buyer.grantId ? (
                            <MetaField label="Grant ID" mono>
                              {buyer.grantId}
                            </MetaField>
                          ) : null}

                          {buyer.machineFingerprintHash ? (
                            <MetaField label="Machine fingerprint (SHA-256)" full mono>
                              {buyer.machineFingerprintHash}
                            </MetaField>
                          ) : null}

                          {buyer.projectIdHash ? (
                            <MetaField label="Project ID (SHA-256)" full mono>
                              {buyer.projectIdHash}
                            </MetaField>
                          ) : null}
                        </dl>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <FxNote
                  tone={VERDICT_CONFIG[verdictKind].tone}
                  title={VERDICT_CONFIG[verdictKind].title}
                  description={VERDICT_CONFIG[verdictKind].description}
                />
              )}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
