import { useMutation, useQuery } from '@tanstack/react-query';
import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { AccountInlineError } from '@/components/account/AccountPage';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import {
  DashboardForensicsSkeleton,
  DashboardGridSkeleton,
} from '@/components/dashboard/DashboardSkeletons';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import { hasActiveCreatorBillingCapability, listCreatorCertificates } from '@/lib/certificates';
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
        <DashboardForensicsSkeleton />
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

  const lookupMutation = useMutation({
    mutationFn: ({ packageId, file }: { packageId: string; file: File }) =>
      runCouplingForensicsLookup({ packageId, file }),
    onMutate: () => {
      setInlineError(null);
      setLookupResult(null);
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
            <AccountInlineError message="Failed to load your products. Refresh the page and try again." />
          </div>
        )}

        {inlineError && (
          <div className="bento-col-12">
            <AccountInlineError message={inlineError} />
          </div>
        )}

        {/* Scan form */}
        <section className="intg-card animate-in bento-col-12">
          <div className="intg-header">
            <div className="intg-title-row">
              <div className="intg-icon">
                <img src="/Icons/Shield.png" alt="" aria-hidden="true" />
              </div>
              <div className="intg-copy">
                <h2 className="intg-title">Leak Tracer</h2>
                <p className="intg-desc">
                  Found a suspicious file? Upload it to find out which buyer it came from.
                </p>
              </div>
            </div>
            <span className="account-badge account-badge--provider" style={{ flexShrink: 0 }}>
              Creator Studio+
            </span>
          </div>

          {hasCapabilityQueryError ? (
            <div className="forensics-upgrade-gate">
              <div className="forensics-upgrade-gate-icon">
                <img src="/Icons/Wrench.png" alt="" aria-hidden="true" />
              </div>
              <p className="forensics-upgrade-gate-title">Could not verify your plan</p>
              <p className="forensics-upgrade-gate-desc">
                Refresh your billing state and try again.
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
                Leak tracing is available on Creator Studio+. Upgrade to identify buyers who share
                your files.
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
                  setInlineError('Choose a product and upload a file to scan.');
                  return;
                }
                lookupMutation.mutate({ packageId: selectedPackageId, file: selectedFile });
              }}
            >
              <div className="forensics-steps">
                {/* Step 1 */}
                <div className="forensics-step">
                  <div className="forensics-step-num">1</div>
                  <div className="forensics-step-body">
                    <label htmlFor="forensics-package" className="forensics-step-label">
                      Which product is this file from?
                    </label>
                    <Select
                      id="forensics-package"
                      value={selectedPackageId}
                      options={packageOptions}
                      onChange={setSelectedPackageId}
                      disabled={lookupMutation.isPending || packageOptions.length === 0}
                    />
                  </div>
                </div>

                {/* Step 2 */}
                <div className="forensics-step">
                  <div className="forensics-step-num">2</div>
                  <div className="forensics-step-body">
                    <p className="forensics-step-label">Upload the suspicious file</p>
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
                          <p className="forensics-dropzone-hint">
                            .unitypackage or .zip · max 100 MB
                          </p>
                        </div>
                      </label>
                    )}
                  </div>
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
                  {lookupMutation.isPending ? 'Scanning...' : 'Find buyer'}
                </YucpButton>
              </div>
            </form>
          )}
        </section>

        {/* Results */}
        {lookupResult && verdictKind && (
          <section className="intg-card animate-in animate-in-delay-1 bento-col-12">
            {verdictKind === 'match' ? (
              <>
                <div className="forensics-verdict forensics-verdict--match">
                  <div className="forensics-verdict-icon">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.35-4.35" />
                    </svg>
                  </div>
                  <div className="forensics-verdict-copy">
                    <p className="forensics-verdict-title">
                      {matchedBuyers.length === 1
                        ? 'Buyer identified'
                        : `${matchedBuyers.length} buyers identified`}
                    </p>
                    <p className="forensics-verdict-desc">
                      {matchedBuyers.length === 1
                        ? 'This file traces back to the following purchase.'
                        : 'This file traces back to the following purchases.'}
                    </p>
                  </div>
                </div>
                <div className="forensics-buyer-list">
                  {matchedBuyers.map((buyer) => (
                    <div key={buyer.licenseSubject} className="forensics-buyer-row">
                      <dl className="forensics-buyer-meta">
                        <div className="forensics-buyer-meta-row">
                          <dt className="forensics-buyer-meta-key">Buyer</dt>
                          <dd className="forensics-buyer-meta-val">{buyer.buyerDisplayLabel}</dd>
                        </div>

                        {buyer.buyerSubjectDiscordUserId &&
                          buyer.buyerSubjectDiscordUserId !== buyer.buyerDisplayLabel && (
                            <div className="forensics-buyer-meta-row">
                              <dt className="forensics-buyer-meta-key">Discord</dt>
                              <dd className="forensics-buyer-meta-val">
                                {buyer.buyerSubjectDiscordUserId}
                              </dd>
                            </div>
                          )}

                        {(buyer.buyerProviderUsername || buyer.buyerProviderUserId) &&
                          (buyer.buyerProviderUsername ?? buyer.buyerProviderUserId) !==
                            buyer.buyerDisplayLabel && (
                            <div className="forensics-buyer-meta-row">
                              <dt className="forensics-buyer-meta-key">Store account</dt>
                              <dd className="forensics-buyer-meta-val">
                                {buyer.buyerProviderUsername ?? buyer.buyerProviderUserId}
                              </dd>
                            </div>
                          )}

                        {buyer.provider && (
                          <div className="forensics-buyer-meta-row">
                            <dt className="forensics-buyer-meta-key">Store</dt>
                            <dd
                              className="forensics-buyer-meta-val"
                              style={{ textTransform: 'capitalize' }}
                            >
                              {buyer.provider}
                            </dd>
                          </div>
                        )}

                        <div className="forensics-buyer-meta-row">
                          <dt className="forensics-buyer-meta-key">Trace recorded</dt>
                          <dd className="forensics-buyer-meta-val">
                            {formatBuyerDate(buyer.createdAt)}
                          </dd>
                        </div>

                        {buyer.licenseKey && (
                          <div className="forensics-buyer-meta-row forensics-buyer-meta-row--full">
                            <dt className="forensics-buyer-meta-key">License key</dt>
                            <dd className="forensics-buyer-meta-val forensics-buyer-meta-val--mono">
                              {buyer.licenseKey}
                            </dd>
                          </div>
                        )}

                        {buyer.runtimeArtifactVersion && (
                          <div className="forensics-buyer-meta-row">
                            <dt className="forensics-buyer-meta-key">Package version</dt>
                            <dd className="forensics-buyer-meta-val forensics-buyer-meta-val--mono">
                              {buyer.runtimeArtifactVersion}
                            </dd>
                          </div>
                        )}

                        {buyer.grantId && (
                          <div className="forensics-buyer-meta-row">
                            <dt className="forensics-buyer-meta-key">Grant ID</dt>
                            <dd className="forensics-buyer-meta-val forensics-buyer-meta-val--mono">
                              {buyer.grantId}
                            </dd>
                          </div>
                        )}

                        {buyer.machineFingerprintHash && (
                          <div className="forensics-buyer-meta-row forensics-buyer-meta-row--full">
                            <dt className="forensics-buyer-meta-key">
                              Machine fingerprint (SHA-256)
                            </dt>
                            <dd className="forensics-buyer-meta-val forensics-buyer-meta-val--mono">
                              {buyer.machineFingerprintHash}
                            </dd>
                          </div>
                        )}

                        {buyer.projectIdHash && (
                          <div className="forensics-buyer-meta-row forensics-buyer-meta-row--full">
                            <dt className="forensics-buyer-meta-key">Project ID (SHA-256)</dt>
                            <dd className="forensics-buyer-meta-val forensics-buyer-meta-val--mono">
                              {buyer.projectIdHash}
                            </dd>
                          </div>
                        )}
                      </dl>
                    </div>
                  ))}
                </div>
              </>
            ) : verdictKind === 'trace_unresolved' ? (
              <div className="forensics-verdict forensics-verdict--neutral">
                <div className="forensics-verdict-icon">
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
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <div className="forensics-verdict-copy">
                  <p className="forensics-verdict-title">Trace found</p>
                  <p className="forensics-verdict-desc">
                    This file matches a traced license in your store, but we don't have the original
                    buyer linked to that license yet.
                  </p>
                </div>
              </div>
            ) : verdictKind === 'tampered' ? (
              <div className="forensics-verdict forensics-verdict--warn">
                <div className="forensics-verdict-icon">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </div>
                <div className="forensics-verdict-copy">
                  <p className="forensics-verdict-title">Tracking removed</p>
                  <p className="forensics-verdict-desc">
                    This file was modified to remove identifying information. We can't trace it to a
                    specific buyer, but the file was tampered with.
                  </p>
                </div>
              </div>
            ) : verdictKind === 'no_assets' ? (
              <div className="forensics-verdict forensics-verdict--neutral">
                <div className="forensics-verdict-icon">
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
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <div className="forensics-verdict-copy">
                  <p className="forensics-verdict-title">No trackable files found</p>
                  <p className="forensics-verdict-desc">
                    This archive doesn't contain any files that can be traced. Make sure you're
                    uploading the right product.
                  </p>
                </div>
              </div>
            ) : (
              <div className="forensics-verdict forensics-verdict--neutral">
                <div className="forensics-verdict-icon">
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
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <div className="forensics-verdict-copy">
                  <p className="forensics-verdict-title">No match found</p>
                  <p className="forensics-verdict-desc">
                    This file doesn't match any purchase in your store. It may have come from a
                    different product or platform.
                  </p>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
