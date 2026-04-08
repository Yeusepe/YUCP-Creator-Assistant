import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { AccountInlineError } from '@/components/account/AccountPage';
import { DashboardPackageRegistrySkeleton } from '@/components/dashboard/DashboardSkeletons';
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
import { copyToClipboard } from '@/lib/utils';

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

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

// SVG icon helpers
function IconPackage() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function IconArchive() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}

function IconRestore() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 .49-4.95" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4h6v2" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function IconChevronDown({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

type PackageRowProps = {
  pkg: CreatorPackageSummary;
  isEditing: boolean;
  editName: string;
  isSaving: boolean;
  isDeleting: boolean;
  isArchiving: boolean;
  isRestoring: boolean;
  archived: boolean;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditChange: (name: string) => void;
  onSave: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onCopyId: () => void;
};

function PackageRow({
  pkg,
  isEditing,
  editName,
  isSaving,
  isDeleting,
  isArchiving,
  isRestoring,
  archived,
  onEditStart,
  onEditCancel,
  onEditChange,
  onSave,
  onArchive,
  onRestore,
  onDelete,
  onCopyId,
}: PackageRowProps) {
  const nameChanged = editName.trim() !== (pkg.packageName ?? '').trim();
  const busy = isSaving || isDeleting || isArchiving || isRestoring;

  return (
    <div className={`pkg-row${archived ? ' pkg-row--archived' : ''}`}>
      <div className="pkg-row__icon">
        <IconPackage />
      </div>

      <div className="pkg-row__body">
        {isEditing ? (
          <input
            className="pkg-row__name-input"
            value={editName}
            // biome-ignore lint/a11y/noAutofocus: inline rename input needs focus to start editing
            autoFocus
            disabled={isSaving}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && nameChanged && !isSaving) onSave();
              if (e.key === 'Escape') onEditCancel();
            }}
            aria-label="Package name"
          />
        ) : (
          <span className="pkg-row__name">
            {pkg.packageName || <em style={{ opacity: 0.5 }}>Unnamed</em>}
          </span>
        )}

        <div className="pkg-row__id-row">
          <span className="pkg-row__id">{pkg.packageId}</span>
          <button
            type="button"
            className="pkg-row__copy-btn"
            onClick={onCopyId}
            title="Copy package ID"
            aria-label="Copy package ID"
          >
            <IconCopy />
          </button>
          <span className="pkg-row__meta">· Updated {formatRelativeTime(pkg.updatedAt)}</span>
        </div>
      </div>

      <span className={`status-pill ${archived ? 'disconnected' : 'connected'}`}>
        {archived ? 'Archived' : 'Active'}
      </span>

      <div className="pkg-row__right">
        {isEditing ? (
          <>
            <button
              type="button"
              className="pkg-row__action-btn"
              disabled={!nameChanged || isSaving}
              onClick={onSave}
              title={isSaving ? 'Saving…' : 'Save name'}
              aria-label="Save package name"
              style={{ color: nameChanged && !isSaving ? '#0ea5e9' : undefined }}
            >
              {isSaving ? (
                <span className="btn-loading-spinner" aria-hidden="true" />
              ) : (
                <svg
                  aria-hidden="true"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="pkg-row__action-btn"
              disabled={isSaving}
              onClick={onEditCancel}
              title="Cancel edit"
              aria-label="Cancel edit"
            >
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </>
        ) : (
          <>
            {!archived && pkg.canArchive !== false ? (
              <button
                type="button"
                className="pkg-row__action-btn"
                disabled={busy}
                onClick={onEditStart}
                title="Rename package"
                aria-label="Rename package"
              >
                <IconPencil />
              </button>
            ) : null}

            {archived ? (
              <button
                type="button"
                className="pkg-row__action-btn"
                disabled={busy || !pkg.canRestore}
                onClick={onRestore}
                title={isRestoring ? 'Restoring…' : 'Restore package'}
                aria-label="Restore package"
              >
                {isRestoring ? (
                  <span
                    className="btn-loading-spinner"
                    aria-hidden="true"
                    style={{ width: '14px', height: '14px' }}
                  />
                ) : (
                  <IconRestore />
                )}
              </button>
            ) : (
              <button
                type="button"
                className="pkg-row__action-btn"
                disabled={busy || !pkg.canArchive}
                onClick={onArchive}
                title={isArchiving ? 'Archiving…' : 'Archive package'}
                aria-label="Archive package"
              >
                {isArchiving ? (
                  <span
                    className="btn-loading-spinner"
                    aria-hidden="true"
                    style={{ width: '14px', height: '14px' }}
                  />
                ) : (
                  <IconArchive />
                )}
              </button>
            )}

            <button
              type="button"
              className="pkg-row__action-btn pkg-row__action-btn--danger"
              disabled={busy || !pkg.canDelete}
              onClick={onDelete}
              title={isDeleting ? 'Removing…' : 'Delete package'}
              aria-label="Delete package"
            >
              {isDeleting ? (
                <span
                  className="btn-loading-spinner"
                  aria-hidden="true"
                  style={{ width: '14px', height: '14px' }}
                />
              ) : (
                <IconTrash />
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function PackageRegistryPanel({
  className = 'intg-card bento-col-12',
  description = 'Package IDs are stable per package. Reuse them across Unity projects, keep their human names current, and remove unused packages before they build history.',
  title = 'Package Registry',
}: PackageRegistryPanelProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { canRunPanelQueries, markSessionExpired } = useDashboardSession();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
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
      [...(packagesQuery.data?.packages ?? [])].sort((a, b) =>
        (a.packageName ?? a.packageId).localeCompare(b.packageName ?? b.packageId)
      ),
    [packagesQuery.data?.packages]
  );
  const activePackages = packages.filter((pkg) => pkg.status === 'active');
  const archivedPackages = packages.filter((pkg) => pkg.status === 'archived');

  function handleCopyId(packageId: string) {
    copyToClipboard(packageId).then((ok) => {
      if (ok) toast.success('Package ID copied');
      else toast.error('Could not copy to clipboard');
    });
  }

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
          <h2 className="intg-title">
            {title}
            {activePackages.length > 0 ? (
              <span
                className="status-pill connected"
                style={{ marginLeft: '10px', fontSize: '11px', verticalAlign: 'middle' }}
              >
                {activePackages.length} active
              </span>
            ) : null}
          </h2>
          <p className="intg-desc">{description}</p>
        </div>
      </div>

      {packagesQuery.isError && !isDashboardAuthError(packagesQuery.error) ? (
        <AccountInlineError message="Failed to load your package registry. Refresh and try again." />
      ) : null}

      {packagesQuery.isLoading ? (
        <DashboardPackageRegistrySkeleton rows={3} />
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
        <div className="pkg-registry">
          <div className="pkg-section-title">Active Packages ({activePackages.length})</div>
          {activePackages.length === 0 ? (
            <p className="account-form-hint">
              No active packages. Restore an archived package to reuse it in Unity or forensics.
            </p>
          ) : (
            <div className="pkg-list">
              {activePackages.map((pkg) => (
                <PackageRow
                  key={pkg.packageId}
                  pkg={pkg}
                  archived={false}
                  isEditing={editingId === pkg.packageId}
                  editName={editingId === pkg.packageId ? editingName : (pkg.packageName ?? '')}
                  isSaving={pendingSaveId === pkg.packageId && renameMutation.isPending}
                  isDeleting={pendingDeleteId === pkg.packageId && deleteMutation.isPending}
                  isArchiving={pendingArchiveId === pkg.packageId && archiveMutation.isPending}
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
                  onArchive={() => archiveMutation.mutate({ packageId: pkg.packageId })}
                  onRestore={() => {}}
                  onDelete={() => deleteMutation.mutate({ packageId: pkg.packageId })}
                  onCopyId={() => handleCopyId(pkg.packageId)}
                />
              ))}
            </div>
          )}

          {archivedPackages.length > 0 ? (
            <div className="pkg-archived-section">
              <button
                type="button"
                className="pkg-archive-toggle"
                aria-expanded={isArchivedExpanded}
                onClick={() => setIsArchivedExpanded((v) => !v)}
              >
                <IconArchive />
                <span>Archived Packages ({archivedPackages.length})</span>
                <IconChevronDown expanded={isArchivedExpanded} />
              </button>
              {isArchivedExpanded ? (
                <div className="pkg-list pkg-list--archived">
                  {archivedPackages.map((pkg) => (
                    <PackageRow
                      key={pkg.packageId}
                      pkg={pkg}
                      archived
                      isEditing={false}
                      editName={pkg.packageName ?? ''}
                      isSaving={false}
                      isDeleting={pendingDeleteId === pkg.packageId && deleteMutation.isPending}
                      isArchiving={false}
                      isRestoring={pendingRestoreId === pkg.packageId && restoreMutation.isPending}
                      onEditStart={() => {}}
                      onEditCancel={() => {}}
                      onEditChange={() => {}}
                      onSave={() => {}}
                      onArchive={() => {}}
                      onRestore={() => restoreMutation.mutate({ packageId: pkg.packageId })}
                      onDelete={() => deleteMutation.mutate({ packageId: pkg.packageId })}
                      onCopyId={() => handleCopyId(pkg.packageId)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
