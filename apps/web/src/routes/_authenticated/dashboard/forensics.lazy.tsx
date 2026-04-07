import { useMutation, useQuery } from '@tanstack/react-query';
import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { AccountInlineError } from '@/components/account/AccountPage';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { DashboardGridSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { Select } from '@/components/ui/Select';
import { StatusChip } from '@/components/ui/StatusChip';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import { listCreatorCertificates } from '@/lib/certificates';
import {
  type CouplingForensicsLookupResponse,
  isCouplingTraceabilityRequiredError,
  listCouplingForensicsPackages,
  runCouplingForensicsLookup,
} from '@/lib/couplingForensics';
import { BILLING_CAPABILITY_KEYS } from '../../../../../../convex/lib/billingCapabilities';

function DashboardForensicsPending() {
  return (
    <div id="tab-panel-forensics" className="dashboard-tab-panel is-active" role="tabpanel">
      <div className="bento-grid">
        <DashboardGridSkeleton cards={3} />
      </div>
    </div>
  );
}

export const Route = createLazyFileRoute('/_authenticated/dashboard/forensics')({
  pendingComponent: DashboardForensicsPending,
  component: DashboardForensics,
});

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatForensicsDate(timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function countMatchedAssets(result: CouplingForensicsLookupResponse | null) {
  return result?.results.filter((entry) => entry.matched).length ?? 0;
}

function noRetryOn4xx(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export default function DashboardForensics() {
  const toast = useToast();
  const { isPersonalDashboard } = useActiveDashboardContext();
  const { canRunPanelQueries, isAuthResolved, markSessionExpired, status } = useDashboardSession();

  const [selectedPackageId, setSelectedPackageId] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [lookupResult, setLookupResult] = useState<CouplingForensicsLookupResponse | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const handleFilePick = (file: File | null) => {
    if (lookupMutation.isPending) return;
    setSelectedFile(file);
    setInlineError(null);
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

  // certificatesQuery must come first — capabilityEnabled is derived from it before packagesQuery
  const certificatesQuery = useQuery({
    queryKey: ['creator-certificates'],
    queryFn: listCreatorCertificates,
    enabled: canRunPanelQueries && isPersonalDashboard,
    retry: noRetryOn4xx,
  });

  const capabilityEnabled =
    certificatesQuery.data?.billing.capabilities.some(
      (capability) =>
        capability.capabilityKey === BILLING_CAPABILITY_KEYS.couplingTraceability &&
        (capability.status === 'active' || capability.status === 'grace')
    ) ?? false;

  // Only fire once capability check resolves — prevents 400 spam for non-Studio+ users
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

  const selectedPackageSummary = useMemo(
    () =>
      (packagesQuery.data?.packages ?? []).find((pkg) => pkg.packageId === selectedPackageId) ??
      null,
    [packagesQuery.data?.packages, selectedPackageId]
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

  const lookupMutation = useMutation({
    mutationFn: ({ packageId, file }: { packageId: string; file: File }) =>
      runCouplingForensicsLookup({ packageId, file }),
    onMutate: () => {
      setInlineError(null);
      setLookupResult(null);
    },
    onSuccess: (result) => {
      setLookupResult(result);
      const matchedAssets = countMatchedAssets(result);
      if (matchedAssets > 0) {
        toast.success('Authorized matches found', {
          description: `${matchedAssets} asset${matchedAssets === 1 ? '' : 's'} matched creator-owned coupling records.`,
        });
      } else if (result.lookupStatus === 'tampered_suspected') {
        toast.info('No coupling signals found', {
          description:
            'The uploaded assets contain no coupling markers. They may be original unprotected files, or coupling signals were stripped.',
        });
      } else if (result.lookupStatus === 'no_candidate_assets') {
        toast.info('No eligible assets found', {
          description: 'No PNG or FBX assets were found in the uploaded archive.',
        });
      } else {
        toast.info('No authorized match found', {
          description: 'The upload did not resolve to a creator-owned coupling record.',
        });
      }
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      if (isCouplingTraceabilityRequiredError(error)) {
        toast.warning('Creator Studio+ required', {
          description: 'Upgrade your creator workspace to use coupling traceability.',
        });
        return;
      }
      setInlineError(
        'Coupling lookup failed. Please try again with a supported .unitypackage or .zip file.'
      );
    },
  });

  const isLoading =
    !isAuthResolved || (canRunPanelQueries && isPersonalDashboard && certificatesQuery.isLoading);
  const hasCapabilityQueryError =
    certificatesQuery.isError && !isDashboardAuthError(certificatesQuery.error);
  const hasQueryError = packagesQuery.isError && !isDashboardAuthError(packagesQuery.error);
  const matchedAssets = countMatchedAssets(lookupResult);

  /* ── Guards ── */

  if (status === 'signed_out' || status === 'expired') {
    return (
      <div id="tab-panel-forensics" className="dashboard-tab-panel is-active" role="tabpanel">
        <DashboardAuthRequiredState
          id="forensics-auth"
          title="Sign in to use coupling forensics"
          description="Your session expired. Sign in again to inspect creator-owned packages."
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
                  Coupling forensics is scoped to your creator-owned package catalog. Open it from
                  your root creator dashboard.
                </p>
              </div>
            </div>
            <Link
              to="/dashboard/forensics"
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
        {hasQueryError && (
          <div className="bento-col-12">
            <AccountInlineError message="Failed to load coupling forensics. Refresh the page and try again." />
          </div>
        )}

        {inlineError && (
          <div className="bento-col-12">
            <AccountInlineError message={inlineError} />
          </div>
        )}

        {/* Scan Form */}
        <section className="intg-card animate-in bento-col-8">
          <div className="intg-header">
            <div className="intg-title-row">
              <div className="intg-icon">
                <img src="/Icons/Shield.png" alt="" aria-hidden="true" />
              </div>
              <div className="intg-copy">
                <h2 className="intg-title">Coupling Forensics</h2>
                <p className="intg-desc">
                  Scan a .unitypackage or .zip against your owned packages to verify authorized
                  coupling records.
                </p>
              </div>
            </div>
            <span className="account-badge account-badge--provider" style={{ flexShrink: 0 }}>
              Creator-only
            </span>
          </div>

          {hasCapabilityQueryError ? (
            <div className="forensics-upgrade-gate">
              <div className="forensics-upgrade-gate-icon">
                <img src="/Icons/Wrench.png" alt="" aria-hidden="true" />
              </div>
              <p className="forensics-upgrade-gate-title">
                Could not verify Creator Studio+ access
              </p>
              <p className="forensics-upgrade-gate-desc">
                Refresh your billing state and try again before starting a coupling scan.
              </p>
              <YucpButton
                yucp="primary"
                pill
                onClick={() => {
                  void certificatesQuery.refetch();
                }}
              >
                Retry
              </YucpButton>
            </div>
          ) : certificatesQuery.isSuccess && capabilityEnabled === false ? (
            <div className="forensics-upgrade-gate">
              <div className="forensics-upgrade-gate-icon">
                <img src="/Icons/BagPlus.png" alt="" aria-hidden="true" />
              </div>
              <p className="forensics-upgrade-gate-title">Creator Studio+ required</p>
              <p className="forensics-upgrade-gate-desc">
                Coupling traceability is a Creator Studio+ feature. Upgrade your plan to inspect
                coupling matches for your packages.
              </p>
              <Link
                to="/dashboard/billing"
                search={(prev) => ({ ...prev, guild_id: undefined, tenant_id: undefined })}
                className="account-btn account-btn--primary"
                style={{ borderRadius: '999px' }}
              >
                Upgrade billing
              </Link>
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!selectedPackageId || !selectedFile) {
                  setInlineError('Choose a package and upload a .unitypackage or .zip file.');
                  return;
                }
                lookupMutation.mutate({ packageId: selectedPackageId, file: selectedFile });
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div>
                  <label htmlFor="forensics-package" className="account-form-label">
                    Package
                  </label>
                  <Select
                    id="forensics-package"
                    value={selectedPackageId}
                    options={packageOptions}
                    onChange={setSelectedPackageId}
                    disabled={lookupMutation.isPending || packageOptions.length === 0}
                  />
                  {selectedPackageSummary ? (
                    <p className="account-form-hint" style={{ marginTop: '6px' }}>
                      Package ID: {selectedPackageSummary.packageId}
                    </p>
                  ) : null}
                </div>

                <div>
                  <p className="account-form-label" style={{ marginBottom: '8px' }}>
                    Upload file
                  </p>
                  {selectedFile ? (
                    <div className="forensics-dropzone forensics-dropzone--selected">
                      <div className="forensics-dropzone-file-icon">
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
                      </div>
                      <div className="forensics-dropzone-file-info">
                        <p className="forensics-dropzone-file-name">{selectedFile.name}</p>
                        <p className="forensics-dropzone-file-size">
                          {formatFileSize(selectedFile.size)}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="forensics-dropzone-clear"
                        disabled={lookupMutation.isPending}
                        onClick={() => {
                          if (lookupMutation.isPending) return;
                          handleFilePick(null);
                          if (fileInputRef.current) fileInputRef.current.value = '';
                        }}
                        aria-label="Remove file"
                      >
                        <svg
                          width="11"
                          height="11"
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
                      </button>
                      <input
                        ref={fileInputRef}
                        id="forensics-file"
                        type="file"
                        accept=".unitypackage,.zip"
                        disabled={lookupMutation.isPending}
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          if (lookupMutation.isPending) return;
                          handleFilePick(e.target.files?.[0] ?? null);
                        }}
                      />
                    </div>
                  ) : (
                    <label
                      htmlFor="forensics-file"
                      className={`forensics-dropzone${isDragOver ? ' is-dragover' : ''}${lookupMutation.isPending ? ' is-disabled' : ''}`}
                      onDragEnter={handleDragEnter}
                      onDragOver={(e) => e.preventDefault()}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                    >
                      <input
                        ref={fileInputRef}
                        id="forensics-file"
                        type="file"
                        accept=".unitypackage,.zip"
                        className="forensics-dropzone-input"
                        disabled={lookupMutation.isPending}
                        onChange={(e) => {
                          if (lookupMutation.isPending) return;
                          handleFilePick(e.target.files?.[0] ?? null);
                        }}
                      />
                      <div className="forensics-dropzone-idle">
                        <div className="forensics-dropzone-icon">
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
                        </div>
                        <p className="forensics-dropzone-label">
                          {isDragOver ? 'Drop to upload' : 'Click to upload or drag & drop'}
                        </p>
                        <p className="forensics-dropzone-hint">.unitypackage or .zip</p>
                      </div>
                    </label>
                  )}
                </div>
              </div>

              <div className="account-form-actions">
                <YucpButton
                  type="submit"
                  yucp="primary"
                  pill
                  isLoading={lookupMutation.isPending}
                  isDisabled={
                    lookupMutation.isPending ||
                    !selectedPackageId ||
                    !selectedFile ||
                    packageOptions.length === 0
                  }
                >
                  {lookupMutation.isPending ? 'Scanning...' : 'Scan upload'}
                </YucpButton>
              </div>
            </form>
          )}
        </section>

        {/* Lookup Summary */}
        <section className="intg-card animate-in animate-in-delay-1 bento-col-4">
          <div className="intg-header">
            <div className="intg-icon">
              <img
                src="/Icons/Wrench.png"
                alt=""
                aria-hidden="true"
                style={{ width: '22px', height: '22px', objectFit: 'contain' }}
              />
            </div>
            <div className="intg-copy">
              <h2 className="intg-title">Scan Results</h2>
              <p className="intg-desc">Stats from the most recent lookup.</p>
            </div>
          </div>

          {lookupResult ? (
            <dl className="account-kv-list">
              <div className="account-kv-row">
                <dt className="account-kv-label">Candidates</dt>
                <dd className="account-kv-value">{lookupResult.candidateAssetCount}</dd>
              </div>
              <div className="account-kv-row">
                <dt className="account-kv-label">Decoded</dt>
                <dd className="account-kv-value">{lookupResult.decodedAssetCount}</dd>
              </div>
              <div className="account-kv-row">
                <dt className="account-kv-label">Matched</dt>
                <dd className="account-kv-value">
                  <StatusChip
                    status={matchedAssets > 0 ? 'connected' : 'pending'}
                    label={String(matchedAssets)}
                  />
                </dd>
              </div>
              <div className="account-kv-row">
                <dt className="account-kv-label">Status</dt>
                <dd className="account-kv-value">{lookupResult.lookupStatus.replace(/_/g, ' ')}</dd>
              </div>
            </dl>
          ) : (
            <div className="account-empty">
              <div className="account-empty-icon">
                <img
                  src="/Icons/Wrench.png"
                  alt=""
                  aria-hidden="true"
                  style={{ width: '20px', height: '20px', objectFit: 'contain', opacity: 0.45 }}
                />
              </div>
              <p className="account-empty-title">No scan yet</p>
              <p className="account-empty-desc">Run a scan to see results here.</p>
            </div>
          )}
        </section>

        {/* Match Results */}
        {lookupResult && (
          <section className="intg-card animate-in animate-in-delay-2 bento-col-12">
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
                <h2 className="intg-title">Match Results</h2>
                <p className="intg-desc">{lookupResult.message}</p>
              </div>
              <StatusChip
                status={matchedAssets > 0 ? 'connected' : 'pending'}
                label={matchedAssets > 0 ? `${matchedAssets} matched` : 'No matches'}
                className="shrink-0"
              />
            </div>

            {matchedAssets > 0 ? (
              <div className="account-list">
                {lookupResult.results
                  .filter((entry) => entry.matched)
                  .map((entry) => (
                    <div key={`${entry.assetPath}:${entry.assetType}`} className="account-list-row">
                      <div className="account-list-row-info">
                        <div className="account-list-row-meta" style={{ marginBottom: '4px' }}>
                          <span
                            className={`account-asset-type-badge account-asset-type-badge--${entry.assetType}`}
                          >
                            {entry.assetType.toUpperCase()}
                          </span>
                          <span className="account-reference-chip">{entry.decoderKind}</span>
                          <span>{entry.tokenLength} hex chars</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {entry.matches.length} record{entry.matches.length === 1 ? '' : 's'}
                          </span>
                        </div>
                        <p className="account-list-row-name">{entry.assetPath}</p>
                        <div className="forensics-match-records">
                          {entry.matches.map((match) => (
                            <div
                              key={`${entry.assetPath}:${match.correlationId ?? match.licenseSubject}`}
                              className="account-match-record"
                            >
                              <div className="account-match-record-header">
                                <StatusChip status="connected" label={match.licenseSubject} />
                                <span className="account-form-hint">
                                  Issued {formatForensicsDate(match.createdAt)}
                                </span>
                              </div>
                              <div className="account-match-record-meta">
                                <span>Trace: {match.assetPath}</span>
                                {match.correlationId && (
                                  <span>Correlation: {match.correlationId}</span>
                                )}
                                {match.runtimeArtifactVersion && (
                                  <span>Runtime: {match.runtimeArtifactVersion}</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="account-empty">
                <div className="account-empty-icon">
                  <img
                    src="/Icons/Wrench.png"
                    alt=""
                    aria-hidden="true"
                    style={{ width: '20px', height: '20px', objectFit: 'contain', opacity: 0.45 }}
                  />
                </div>
                {lookupResult?.lookupStatus === 'tampered_suspected' ? (
                  <>
                    <p className="account-empty-title">No coupling signals found</p>
                    <p className="account-empty-desc">
                      The uploaded assets contain no coupling markers. They may be original
                      unprotected files, or coupling signals were stripped.
                    </p>
                  </>
                ) : lookupResult?.lookupStatus === 'no_candidate_assets' ? (
                  <>
                    <p className="account-empty-title">No eligible assets found</p>
                    <p className="account-empty-desc">
                      No PNG or FBX assets were found in the uploaded archive.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="account-empty-title">No authorized match found</p>
                    <p className="account-empty-desc">
                      The upload did not resolve to a coupling token under the selected package.
                    </p>
                  </>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
