import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { AccountInlineError } from '@/components/account/AccountPage';
import { useToast } from '@/components/ui/Toast';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import {
  archiveCreatorPackage,
  type CreatorPackageListResponse,
  type CreatorPackageSummary,
  deleteCreatorPackage,
  listCreatorPackages,
  renameCreatorPackage,
  restoreCreatorPackage,
} from '@/lib/packages';

interface PackageRegistryPanelProps {
  className?: string;
  description?: string;
  title?: string;
}

const creatorPackagesQueryKey = ['creator-packages'] as const;

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

function formatPackageTimestamp(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function PackageRegistryPanel({
  className = 'intg-card bento-col-12',
  description = 'Package IDs are stable per package. Reuse them across Unity projects, keep their human names current, and remove unused packages before they build history.',
  title = 'Package Registry',
}: PackageRegistryPanelProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { canRunPanelQueries, markSessionExpired } = useDashboardSession();
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  const [pendingSaveId, setPendingSaveId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingArchiveId, setPendingArchiveId] = useState<string | null>(null);
  const [pendingRestoreId, setPendingRestoreId] = useState<string | null>(null);
  const [isArchivedExpanded, setIsArchivedExpanded] = useState(false);

  const packagesQuery = useQuery({
    queryKey: creatorPackagesQueryKey,
    queryFn: () => listCreatorPackages({ includeArchived: true }),
    enabled: canRunPanelQueries,
    retry: false,
  });

  useEffect(() => {
    if (isDashboardAuthError(packagesQuery.error)) {
      markSessionExpired();
    }
  }, [markSessionExpired, packagesQuery.error]);

  useEffect(() => {
    if (!packagesQuery.data?.packages) {
      return;
    }
    setDraftNames((current) => {
      const next = { ...current };
      for (const pkg of packagesQuery.data.packages) {
        if (!(pkg.packageId in next)) {
          next[pkg.packageId] = pkg.packageName ?? '';
        }
      }
      return next;
    });
  }, [packagesQuery.data?.packages]);

  const renameMutation = useMutation({
    mutationFn: renameCreatorPackage,
    onMutate: ({ packageId }) => setPendingSaveId(packageId),
    onSuccess: async () => {
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

  const deleteMutation = useMutation({
    mutationFn: deleteCreatorPackage,
    onMutate: ({ packageId }) => setPendingDeleteId(packageId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: creatorPackagesQueryKey });
      toast.success('Package removed');
    },
    onError: (error) => {
      if (isDashboardAuthError(error)) {
        markSessionExpired();
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : 'This package could not be removed.';
      toast.error('Could not remove package', { description: errorMessage });
    },
    onSettled: () => setPendingDeleteId(null),
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
      toast.success('Package archived');
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
        error instanceof Error ? error.message : 'This package could not be archived.';
      toast.error('Could not archive package', { description: errorMessage });
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

  const packages = useMemo(
    () =>
      [...(packagesQuery.data?.packages ?? [])].sort((left, right) =>
        (left.packageName ?? left.packageId).localeCompare(right.packageName ?? right.packageId)
      ),
    [packagesQuery.data?.packages]
  );
  const activePackages = packages.filter((pkg) => pkg.status === 'active');
  const archivedPackages = packages.filter((pkg) => pkg.status === 'archived');

  return (
    <section className={className}>
      <div className="intg-header">
        <div className="intg-icon">
          <img
            src="/Icons/Library.png"
            alt=""
            aria-hidden="true"
            style={{ width: '22px', height: '22px', objectFit: 'contain' }}
          />
        </div>
        <div className="intg-copy">
          <h2 className="intg-title">{title}</h2>
          <p className="intg-desc">{description}</p>
        </div>
      </div>

      {packagesQuery.isError && !isDashboardAuthError(packagesQuery.error) ? (
        <AccountInlineError message="Failed to load your package registry. Refresh and try again." />
      ) : null}

      {packagesQuery.isLoading ? (
        <div className="account-empty">
          <div className="account-empty-icon">
            <img
              src="/Icons/Library.png"
              alt=""
              aria-hidden="true"
              style={{ width: '20px', height: '20px', objectFit: 'contain', opacity: 0.45 }}
            />
          </div>
          <p className="account-empty-title">Loading package registry...</p>
          <p className="account-empty-desc">
            Pulling your current package IDs so certificates and forensics stay aligned.
          </p>
        </div>
      ) : packages.length === 0 ? (
        <div className="account-empty">
          <div className="account-empty-icon">
            <img
              src="/Icons/Library.png"
              alt=""
              aria-hidden="true"
              style={{ width: '20px', height: '20px', objectFit: 'contain', opacity: 0.45 }}
            />
          </div>
          <p className="account-empty-title">No packages registered yet</p>
          <p className="account-empty-desc">
            Once you export and sign a package, it will appear here and can be reused from the Unity
            package exporter.
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '18px' }}>
          <div>
            <div className="account-list-section-title">Active Packages</div>
            {activePackages.length === 0 ? (
              <p className="account-form-hint" style={{ marginTop: '10px' }}>
                No active packages right now. Restore an archived package to reuse it in Unity or
                forensics.
              </p>
            ) : (
              <div className="account-list">
                {activePackages.map((pkg) => {
                  const draftName = draftNames[pkg.packageId] ?? pkg.packageName ?? '';
                  const isSaving = pendingSaveId === pkg.packageId && renameMutation.isPending;
                  const isDeleting = pendingDeleteId === pkg.packageId && deleteMutation.isPending;
                  const isArchiving =
                    pendingArchiveId === pkg.packageId && archiveMutation.isPending;

                  return (
                    <div key={pkg.packageId} className="account-list-row">
                      <div className="account-list-row-info" style={{ width: '100%' }}>
                        <label
                          className="account-form-label"
                          htmlFor={`package-name-${pkg.packageId}`}
                        >
                          Package Name
                        </label>
                        <input
                          id={`package-name-${pkg.packageId}`}
                          className="account-input"
                          value={draftName}
                          disabled={isSaving || isDeleting || isArchiving}
                          onChange={(event) =>
                            setDraftNames((current) => ({
                              ...current,
                              [pkg.packageId]: event.target.value,
                            }))
                          }
                        />
                        <div className="account-list-row-meta" style={{ marginTop: '8px' }}>
                          <span>{pkg.packageId}</span>
                          <span aria-hidden="true">·</span>
                          <span>Registered {formatPackageTimestamp(pkg.registeredAt)}</span>
                          <span aria-hidden="true">·</span>
                          <span>Updated {formatPackageTimestamp(pkg.updatedAt)}</span>
                        </div>
                        {!pkg.canDelete && pkg.deleteBlockedReason ? (
                          <p className="account-form-hint" style={{ marginTop: '8px' }}>
                            {pkg.deleteBlockedReason}
                          </p>
                        ) : null}
                      </div>
                      <div className="account-list-row-actions">
                        <button
                          type="button"
                          className={`account-btn account-btn--secondary${isSaving ? ' btn-loading' : ''}`}
                          style={{ borderRadius: '10px' }}
                          disabled={
                            isSaving ||
                            isDeleting ||
                            isArchiving ||
                            !draftName.trim() ||
                            draftName.trim() === (pkg.packageName ?? '').trim()
                          }
                          onClick={() =>
                            renameMutation.mutate({
                              packageId: pkg.packageId,
                              packageName: draftName.trim(),
                            })
                          }
                        >
                          {isSaving ? (
                            <span className="btn-loading-spinner" aria-hidden="true" />
                          ) : null}
                          <span>{isSaving ? 'Saving...' : 'Save Name'}</span>
                        </button>
                        <button
                          type="button"
                          className={`account-btn account-btn--secondary${isArchiving ? ' btn-loading' : ''}`}
                          style={{ borderRadius: '10px' }}
                          disabled={isSaving || isDeleting || isArchiving || !pkg.canArchive}
                          onClick={() => archiveMutation.mutate({ packageId: pkg.packageId })}
                        >
                          {isArchiving ? (
                            <span className="btn-loading-spinner" aria-hidden="true" />
                          ) : null}
                          <span>{isArchiving ? 'Archiving...' : 'Archive'}</span>
                        </button>
                        <button
                          type="button"
                          className={`account-btn account-btn--secondary${isDeleting ? ' btn-loading' : ''}`}
                          style={{ borderRadius: '10px' }}
                          disabled={isSaving || isDeleting || isArchiving || !pkg.canDelete}
                          onClick={() => deleteMutation.mutate({ packageId: pkg.packageId })}
                        >
                          {isDeleting ? (
                            <span className="btn-loading-spinner" aria-hidden="true" />
                          ) : null}
                          <span>{isDeleting ? 'Removing...' : 'Delete'}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {archivedPackages.length > 0 ? (
            <div>
              <button
                type="button"
                className="account-btn account-btn--secondary"
                style={{
                  borderRadius: '10px',
                  justifyContent: 'space-between',
                  width: '100%',
                }}
                aria-expanded={isArchivedExpanded}
                onClick={() => setIsArchivedExpanded((current) => !current)}
              >
                <span>Archived Packages ({archivedPackages.length})</span>
                <span aria-hidden="true">{isArchivedExpanded ? 'Hide' : 'Show'}</span>
              </button>
              {isArchivedExpanded ? (
                <>
                  <p
                    className="account-form-hint"
                    style={{ marginTop: '10px', marginBottom: '12px' }}
                  >
                    Archived packages stay in audit history, disappear from forensics selectors, and
                    cannot be updated until restored.
                  </p>
                  <div className="account-list">
                    {archivedPackages.map((pkg) => {
                      const draftName = draftNames[pkg.packageId] ?? pkg.packageName ?? '';
                      const isDeleting =
                        pendingDeleteId === pkg.packageId && deleteMutation.isPending;
                      const isRestoring =
                        pendingRestoreId === pkg.packageId && restoreMutation.isPending;

                      return (
                        <div key={pkg.packageId} className="account-list-row">
                          <div className="account-list-row-info" style={{ width: '100%' }}>
                            <label
                              className="account-form-label"
                              htmlFor={`package-name-${pkg.packageId}`}
                            >
                              Package Name
                            </label>
                            <input
                              id={`package-name-${pkg.packageId}`}
                              className="account-input"
                              value={draftName}
                              disabled
                              readOnly
                            />
                            <div className="account-list-row-meta" style={{ marginTop: '8px' }}>
                              <span>{pkg.packageId}</span>
                              <span aria-hidden="true">·</span>
                              <span>
                                Archived {formatPackageTimestamp(pkg.archivedAt ?? pkg.updatedAt)}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>Updated {formatPackageTimestamp(pkg.updatedAt)}</span>
                            </div>
                            <p className="account-form-hint" style={{ marginTop: '8px' }}>
                              Archived packages are hidden from forensics and blocked from signing
                              updates until restored.
                            </p>
                          </div>
                          <div className="account-list-row-actions">
                            <button
                              type="button"
                              className={`account-btn account-btn--secondary${isRestoring ? ' btn-loading' : ''}`}
                              style={{ borderRadius: '10px' }}
                              disabled={isDeleting || isRestoring || !pkg.canRestore}
                              onClick={() => restoreMutation.mutate({ packageId: pkg.packageId })}
                            >
                              {isRestoring ? (
                                <span className="btn-loading-spinner" aria-hidden="true" />
                              ) : null}
                              <span>{isRestoring ? 'Restoring...' : 'Restore'}</span>
                            </button>
                            <button
                              type="button"
                              className={`account-btn account-btn--secondary${isDeleting ? ' btn-loading' : ''}`}
                              style={{ borderRadius: '10px' }}
                              disabled={isDeleting || isRestoring || !pkg.canDelete}
                              onClick={() => deleteMutation.mutate({ packageId: pkg.packageId })}
                            >
                              {isDeleting ? (
                                <span className="btn-loading-spinner" aria-hidden="true" />
                              ) : null}
                              <span>{isDeleting ? 'Removing...' : 'Delete'}</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
