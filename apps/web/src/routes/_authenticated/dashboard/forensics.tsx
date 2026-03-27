import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { AccountInlineError } from '@/components/account/AccountPage';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { DashboardGridSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import { ApiError } from '@/api/client';
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

export const Route = createFileRoute('/_authenticated/dashboard/forensics')({
  pendingComponent: DashboardForensicsPending,
  component: DashboardForensics,
});

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
      (packagesQuery.data?.packages ?? []).map((packageId) => ({
        value: packageId,
        label: packageId,
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
    !isAuthResolved ||
    (canRunPanelQueries && isPersonalDashboard && certificatesQuery.isLoading);
  const hasQueryError =
    (packagesQuery.isError && !isDashboardAuthError(packagesQuery.error)) ||
    (certificatesQuery.isError && !isDashboardAuthError(certificatesQuery.error));
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
                <img src="/Icons/Shield.png" alt="" aria-hidden="true" style={{ width: '22px', height: '22px', objectFit: 'contain' }} />
              </div>
              <div className="intg-copy" style={{ flex: 1 }}>
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
            <div className="intg-icon">
              <img src="/Icons/Shield.png" alt="" aria-hidden="true" style={{ width: '22px', height: '22px', objectFit: 'contain' }} />
            </div>
            <div className="intg-copy" style={{ flex: 1 }}>
              <h1 className="intg-title">Coupling Forensics</h1>
              <p className="intg-desc">
                Upload a .unitypackage or .zip, restrict the lookup to one of your packages, and
                resolve only authorized coupling matches.
              </p>
            </div>
            <span className="account-badge account-badge--provider" style={{ flexShrink: 0 }}>
              Creator-only
            </span>
          </div>

          {!capabilityEnabled ? (
            <div className="account-empty">
              <div className="account-empty-icon">
                <img src="/Icons/BagPlus.png" alt="" aria-hidden="true" style={{ width: '20px', height: '20px', objectFit: 'contain', opacity: 0.5 }} />
              </div>
              <p className="account-empty-title">Creator Studio+ required</p>
              <p className="account-empty-desc">
                Coupling traceability is locked to Creator Studio+. Upgrade your billing plan to
                inspect coupling matches for your packages.
              </p>
              <Link
                to="/dashboard/certificates"
                search={(prev) => ({ ...prev, guild_id: undefined, tenant_id: undefined })}
                className="account-btn account-btn--primary"
                style={{ borderRadius: '999px', marginTop: '4px' }}
              >
                Upgrade billing
              </Link>
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!selectedPackageId || !selectedFile) {
                  setInlineError(
                    'Choose one of your packages and upload a .unitypackage or .zip file.'
                  );
                  return;
                }
                lookupMutation.mutate({ packageId: selectedPackageId, file: selectedFile });
              }}
            >
              <div className="account-form-field-group">
                <div>
                  <label htmlFor="forensics-package" className="account-form-label">
                    Package scope
                  </label>
                  <Select
                    id="forensics-package"
                    value={selectedPackageId}
                    options={packageOptions}
                    onChange={setSelectedPackageId}
                    disabled={lookupMutation.isPending || packageOptions.length === 0}
                  />
                </div>

                <div>
                  <label htmlFor="forensics-file" className="account-form-label">
                    Upload package
                  </label>
                  <input
                    id="forensics-file"
                    type="file"
                    accept=".unitypackage,.zip"
                    className="account-file-input"
                    disabled={lookupMutation.isPending}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      setSelectedFile(file);
                      setInlineError(null);
                    }}
                  />
                </div>
              </div>

              <div className="account-form-actions">
                <button
                  type="submit"
                  className={`account-btn account-btn--primary${lookupMutation.isPending ? ' btn-loading' : ''}`}
                  style={{ borderRadius: '999px' }}
                  disabled={
                    lookupMutation.isPending ||
                    !selectedPackageId ||
                    !selectedFile ||
                    packageOptions.length === 0
                  }
                >
                  {lookupMutation.isPending && <span className="btn-loading-spinner" aria-hidden="true" />}
                  <span>{lookupMutation.isPending ? 'Scanning...' : 'Scan upload'}</span>
                </button>
                <span className="account-form-hint">
                  {selectedFile
                    ? `Selected: ${selectedFile.name}`
                    : 'Supported: .unitypackage and .zip'}
                </span>
              </div>
            </form>
          )}
        </section>

        {/* Lookup Summary */}
        <section className="intg-card animate-in animate-in-delay-1 bento-col-4">
          <div className="intg-header">
            <div className="intg-icon">
              <img src="/Icons/Wrench.png" alt="" aria-hidden="true" style={{ width: '22px', height: '22px', objectFit: 'contain' }} />
            </div>
            <div className="intg-copy" style={{ flex: 1 }}>
              <h2 className="intg-title">Lookup Summary</h2>
              <p className="intg-desc">Creator-scoped scan with redacted match output only.</p>
            </div>
          </div>

          <dl className="account-kv-list">
            <div className="account-kv-row">
              <dt className="account-kv-label">Capability</dt>
              <dd className="account-kv-value">
                {capabilityEnabled ? (
                  <span className="account-badge account-badge--active">Enabled</span>
                ) : (
                  <span className="account-badge account-badge--provider">Locked</span>
                )}
              </dd>
            </div>
            <div className="account-kv-row">
              <dt className="account-kv-label">Owned packages</dt>
              <dd className="account-kv-value">{packageOptions.length}</dd>
            </div>
            <div className="account-kv-row">
              <dt className="account-kv-label">Candidates scanned</dt>
              <dd className="account-kv-value">{lookupResult?.candidateAssetCount ?? '—'}</dd>
            </div>
            <div className="account-kv-row">
              <dt className="account-kv-label">Decoded assets</dt>
              <dd className="account-kv-value">{lookupResult?.decodedAssetCount ?? '—'}</dd>
            </div>
            <div className="account-kv-row">
              <dt className="account-kv-label">Matched assets</dt>
              <dd className="account-kv-value">{lookupResult ? matchedAssets : '—'}</dd>
            </div>
            <div className="account-kv-row">
              <dt className="account-kv-label">Status</dt>
              <dd className="account-kv-value">
                {lookupResult ? lookupResult.lookupStatus.replace(/_/g, ' ') : '—'}
              </dd>
            </div>
          </dl>

          {!lookupResult && (
            <div className="account-empty" style={{ marginTop: '18px' }}>
              <div className="account-empty-icon">
                <img src="/Icons/Wrench.png" alt="" aria-hidden="true" style={{ width: '20px', height: '20px', objectFit: 'contain', opacity: 0.45 }} />
              </div>
              <p className="account-empty-title">No lookup yet</p>
              <p className="account-empty-desc">
                Run a scan to see whether the upload resolves to an authorized coupling record.
              </p>
            </div>
          )}
        </section>

        {/* Match Results */}
        {lookupResult && (
          <section className="intg-card animate-in animate-in-delay-2 bento-col-12">
            <div className="intg-header">
              <div className="intg-icon">
                <img src="/Icons/Shield.png" alt="" aria-hidden="true" style={{ width: '22px', height: '22px', objectFit: 'contain' }} />
              </div>
              <div className="intg-copy" style={{ flex: 1 }}>
                <h2 className="intg-title">Authorized Match Results</h2>
                <p className="intg-desc">{lookupResult.message}</p>
              </div>
              <span
                className={`account-badge account-badge--${matchedAssets > 0 ? 'connected' : 'provider'}`}
                style={{ flexShrink: 0 }}
              >
                {matchedAssets > 0 ? `${matchedAssets} matched` : 'No matches'}
              </span>
            </div>

            {matchedAssets > 0 ? (
              <div className="account-list">
                {lookupResult.results
                  .filter((entry) => entry.matched)
                  .map((entry) => (
                    <div key={`${entry.assetPath}:${entry.assetType}`} className="account-list-row">
                      <div className="account-list-row-icon">
                        <span className={`account-asset-type-badge account-asset-type-badge--${entry.assetType}`}>
                          {entry.assetType.toUpperCase()}
                        </span>
                      </div>
                      <div className="account-list-row-info">
                        <p className="account-list-row-name">{entry.assetPath}</p>
                        <div className="account-list-row-meta">
                          <span className="account-reference-chip">{entry.decoderKind}</span>
                          <span>{entry.tokenLength} hex chars</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {entry.matches.length} record{entry.matches.length === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
                          {entry.matches.map((match) => (
                            <div
                              key={`${entry.assetPath}:${match.correlationId ?? match.licenseSubject}`}
                              className="account-match-record"
                            >
                              <div className="account-match-record-header">
                                <span className="account-badge account-badge--connected">
                                  {match.licenseSubject}
                                </span>
                                <span className="account-form-hint">
                                  Issued {formatForensicsDate(match.createdAt)}
                                </span>
                              </div>
                              <div className="account-match-record-meta">
                                <span>Trace asset: {match.assetPath}</span>
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
                  <img src="/Icons/Wrench.png" alt="" aria-hidden="true" style={{ width: '20px', height: '20px', objectFit: 'contain', opacity: 0.45 }} />
                </div>
                <p className="account-empty-title">No authorized match found</p>
                <p className="account-empty-desc">
                  The upload did not resolve to a coupling token under the package you selected.
                </p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
