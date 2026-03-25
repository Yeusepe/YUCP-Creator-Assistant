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

export default function DashboardForensics() {
  const toast = useToast();
  const { isPersonalDashboard } = useActiveDashboardContext();
  const { canRunPanelQueries, isAuthResolved, markSessionExpired, status } = useDashboardSession();

  const [selectedPackageId, setSelectedPackageId] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [lookupResult, setLookupResult] = useState<CouplingForensicsLookupResponse | null>(null);

  const packagesQuery = useQuery({
    queryKey: ['coupling-forensics', 'packages'],
    queryFn: listCouplingForensicsPackages,
    enabled: canRunPanelQueries && isPersonalDashboard,
  });

  const certificatesQuery = useQuery({
    queryKey: ['creator-certificates'],
    queryFn: listCreatorCertificates,
    enabled: canRunPanelQueries && isPersonalDashboard,
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
      if (selectedPackageId) {
        setSelectedPackageId('');
      }
      return;
    }
    if (!packageOptions.some((option) => option.value === selectedPackageId)) {
      setSelectedPackageId(packageOptions[0]?.value ?? '');
    }
  }, [packageOptions, selectedPackageId]);

  const capabilityEnabled =
    certificatesQuery.data?.billing.capabilities.some(
      (capability) =>
        capability.capabilityKey === BILLING_CAPABILITY_KEYS.couplingTraceability &&
        (capability.status === 'active' || capability.status === 'grace')
    ) ?? false;

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
    (canRunPanelQueries &&
      isPersonalDashboard &&
      (packagesQuery.isLoading || certificatesQuery.isLoading));
  const hasQueryError =
    (packagesQuery.isError && !isDashboardAuthError(packagesQuery.error)) ||
    (certificatesQuery.isError && !isDashboardAuthError(certificatesQuery.error));
  const matchedAssets = countMatchedAssets(lookupResult);

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

        <section className="intg-card animate-in bento-col-8">
          <div className="intg-header">
            <div className="intg-icon">
              <img
                src="/Icons/Shield.png"
                alt=""
                aria-hidden="true"
                style={{ width: '22px', height: '22px', objectFit: 'contain' }}
              />
            </div>
            <div className="intg-copy" style={{ flex: 1 }}>
              <h1 className="intg-title">Coupling Forensics</h1>
              <p className="intg-desc">
                Upload a `.unitypackage` or `.zip`, restrict the lookup to one of your packages, and
                resolve only authorized coupling matches.
              </p>
            </div>
            <span className="account-badge account-badge--provider" style={{ flexShrink: 0 }}>
              Creator-only
            </span>
          </div>

          {!capabilityEnabled && !isLoading ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr)',
                gap: '16px',
              }}
            >
              <div className="account-empty">
                <div className="account-empty-icon">
                  <img
                    src="/Icons/BagPlus.png"
                    alt=""
                    aria-hidden="true"
                    style={{ width: '20px', height: '20px', objectFit: 'contain', opacity: 0.5 }}
                  />
                </div>
                <p className="account-empty-title">Creator Studio+ required</p>
                <p className="account-empty-desc">
                  Coupling traceability is locked to Creator Studio+. Upgrade billing to inspect
                  coupling matches for your packages.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                <Link
                  to="/dashboard/certificates"
                  search={(prev) => ({ ...prev, guild_id: undefined, tenant_id: undefined })}
                  className="account-btn account-btn--primary"
                  style={{ borderRadius: '999px' }}
                >
                  Upgrade billing
                </Link>
              </div>
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
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                  gap: '16px',
                }}
              >
                <div>
                  <label
                    htmlFor="forensics-package"
                    style={{
                      display: 'block',
                      marginBottom: '8px',
                      fontSize: '12px',
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: '#64748b',
                    }}
                  >
                    Package scope
                  </label>
                  <Select
                    id="forensics-package"
                    value={selectedPackageId}
                    options={packageOptions}
                    onChange={setSelectedPackageId}
                    disabled={lookupMutation.isPending || packageOptions.length === 0 || isLoading}
                  />
                </div>

                <div>
                  <label
                    htmlFor="forensics-file"
                    style={{
                      display: 'block',
                      marginBottom: '8px',
                      fontSize: '12px',
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: '#64748b',
                    }}
                  >
                    Upload package
                  </label>
                  <input
                    id="forensics-file"
                    type="file"
                    accept=".unitypackage,.zip"
                    disabled={lookupMutation.isPending || isLoading}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      setSelectedFile(file);
                      setInlineError(null);
                    }}
                    style={{
                      width: '100%',
                      padding: '12px 14px',
                      borderRadius: '10px',
                      border: '1px solid rgba(148,163,184,0.22)',
                      background: 'rgba(255,255,255,0.9)',
                      color: '#0f172a',
                    }}
                  />
                </div>
              </div>

              <div
                style={{
                  marginTop: '16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  flexWrap: 'wrap',
                }}
              >
                <button
                  type="submit"
                  className={`account-btn account-btn--primary${lookupMutation.isPending ? ' btn-loading' : ''}`}
                  style={{ borderRadius: '999px' }}
                  disabled={
                    lookupMutation.isPending ||
                    isLoading ||
                    !selectedPackageId ||
                    !selectedFile ||
                    packageOptions.length === 0
                  }
                >
                  {lookupMutation.isPending && (
                    <span className="btn-loading-spinner" aria-hidden="true" />
                  )}
                  <span className="btn-label">
                    {lookupMutation.isPending ? 'Scanning...' : 'Scan upload'}
                  </span>
                </button>

                <div style={{ color: '#64748b', fontSize: '13px' }}>
                  {selectedFile
                    ? `Selected file: ${selectedFile.name}`
                    : 'Supported upload types: .unitypackage and .zip'}
                </div>
              </div>
            </form>
          )}
        </section>

        <section className="intg-card animate-in animate-in-delay-1 bento-col-4">
          <div className="intg-header">
            <div className="intg-icon">
              <img
                src="/Icons/Laptop.png"
                alt=""
                aria-hidden="true"
                style={{ width: '22px', height: '22px', objectFit: 'contain' }}
              />
            </div>
            <div className="intg-copy" style={{ flex: 1 }}>
              <h2 className="intg-title">Lookup Summary</h2>
              <p className="intg-desc">
                Remote coupling scan, creator-owned package scope, and redacted match output only.
              </p>
            </div>
          </div>

          <dl className="account-kv-list">
            <div className="account-kv-row">
              <dt className="account-kv-label">Capability</dt>
              <dd className="account-kv-value">{capabilityEnabled ? 'Enabled' : 'Locked'}</dd>
            </div>
            <div className="account-kv-row">
              <dt className="account-kv-label">Owned packages</dt>
              <dd className="account-kv-value">{packageOptions.length}</dd>
            </div>
            <div className="account-kv-row">
              <dt className="account-kv-label">Candidates scanned</dt>
              <dd className="account-kv-value">{lookupResult?.candidateAssetCount ?? '-'}</dd>
            </div>
            <div className="account-kv-row">
              <dt className="account-kv-label">Decoded assets</dt>
              <dd className="account-kv-value">{lookupResult?.decodedAssetCount ?? '-'}</dd>
            </div>
            <div className="account-kv-row">
              <dt className="account-kv-label">Matched assets</dt>
              <dd className="account-kv-value">{lookupResult ? matchedAssets : '-'}</dd>
            </div>
          </dl>

          {!lookupResult && !isLoading && (
            <div className="account-empty" style={{ marginTop: '18px' }}>
              <div className="account-empty-icon">
                <img
                  src="/Icons/Wrench.png"
                  alt=""
                  aria-hidden="true"
                  style={{ width: '20px', height: '20px', objectFit: 'contain', opacity: 0.45 }}
                />
              </div>
              <p className="account-empty-title">No lookup yet</p>
              <p className="account-empty-desc">
                Run a scan to see whether the upload resolves to an authorized coupling record.
              </p>
            </div>
          )}
        </section>

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
                      <div
                        className="account-list-row-icon"
                        style={{
                          background:
                            entry.assetType === 'fbx'
                              ? 'rgba(59,130,246,0.1)'
                              : 'rgba(16,185,129,0.1)',
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            fontSize: '11px',
                            fontWeight: 800,
                            color: entry.assetType === 'fbx' ? '#2563eb' : '#059669',
                          }}
                        >
                          {entry.assetType.toUpperCase()}
                        </span>
                      </div>

                      <div className="account-list-row-info">
                        <p className="account-list-row-name">{entry.assetPath}</p>
                        <div className="account-list-row-meta" style={{ flexWrap: 'wrap' }}>
                          <span className="account-reference-chip">{entry.decoderKind}</span>
                          <span>{entry.tokenLength} hex chars</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {entry.matches.length} record{entry.matches.length === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div
                          style={{
                            display: 'grid',
                            gap: '8px',
                            marginTop: '10px',
                          }}
                        >
                          {entry.matches.map((match) => (
                            <div
                              key={`${entry.assetPath}:${match.correlationId ?? match.licenseSubject}`}
                              style={{
                                padding: '12px 14px',
                                borderRadius: '10px',
                                border: '1px solid rgba(148,163,184,0.18)',
                                background: 'rgba(15,23,42,0.03)',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '10px',
                                  flexWrap: 'wrap',
                                }}
                              >
                                <span className="account-badge account-badge--connected">
                                  {match.licenseSubject}
                                </span>
                                <span style={{ color: '#64748b', fontSize: '12px' }}>
                                  Issued {formatForensicsDate(match.createdAt)}
                                </span>
                              </div>
                              <div
                                style={{
                                  marginTop: '8px',
                                  display: 'flex',
                                  gap: '8px',
                                  flexWrap: 'wrap',
                                  color: '#64748b',
                                  fontSize: '12px',
                                }}
                              >
                                <span>Trace asset: {match.assetPath}</span>
                                {match.correlationId ? (
                                  <span>Correlation: {match.correlationId}</span>
                                ) : null}
                                {match.runtimeArtifactVersion ? (
                                  <span>Runtime: {match.runtimeArtifactVersion}</span>
                                ) : null}
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
