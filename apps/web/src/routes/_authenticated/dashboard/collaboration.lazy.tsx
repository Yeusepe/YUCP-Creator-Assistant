import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createLazyFileRoute } from '@tanstack/react-router';
import type { CreatorWorkspaceGrant } from '@yucp/shared/creatorWorkspacePermissions';
import { useEffect, useMemo, useState } from 'react';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import {
  type CollaboratorPermissionResource,
  CollaboratorPermissionSheet,
} from '@/components/dashboard/CollaboratorPermissionSheet';
import { DashboardBodyPortal } from '@/components/dashboard/DashboardBodyPortal';
import { DashboardSkeletonSwap } from '@/components/dashboard/DashboardSkeletonSwap';
import {
  DashboardActionRowSkeleton,
  DashboardListSkeleton,
} from '@/components/dashboard/DashboardSkeletons';
import { HoldConfirmButton } from '@/components/ui/HoldConfirmButton';
import { Icon } from '@/components/ui/Icon';
import { YucpButton } from '@/components/ui/YucpButton';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import { useDashboardShell } from '@/hooks/useDashboardShell';
import type {
  CollabAsCollaboratorSummary,
  CollabProviderSummary,
  CreatorWorkspaceMemberSummary,
  PendingCollabInvite,
} from '@/lib/dashboard';
import {
  createCollabInvite,
  getCreatorWorkspaceMemberPermissions,
  listCollabConnectionsAsCollaborator,
  listCollabInvites,
  listCollabProviders,
  listCreatorWorkspaceMembers,
  removeCollabConnectionAsCollaborator,
  removeCreatorWorkspaceMember,
  revokeCollabInvite,
  updateCreatorWorkspaceMemberPermissions,
} from '@/lib/dashboard';
import {
  dashboardPanelQueryOptions,
  dashboardPollingQueryOptions,
} from '@/lib/dashboardQueryOptions';
import { listCreatorPackagePickerProducts } from '@/lib/packages';
import { copyToClipboard } from '@/lib/utils';

function DashboardCollaborationPending() {
  return (
    <div
      id="tab-panel-collaboration"
      className="dashboard-tab-panel is-active"
      role="tabpanel"
      aria-labelledby="tab-btn-collaboration"
    >
      <div className="bento-grid">
        <DashboardListSkeleton rows={2} />
        <DashboardListSkeleton rows={1} showAction={false} />
      </div>
    </div>
  );
}

export const Route = createLazyFileRoute('/_authenticated/dashboard/collaboration')({
  pendingComponent: DashboardCollaborationPending,
  component: DashboardCollaboration,
});

function DashboardCollaboration() {
  const { viewer } = useDashboardShell();
  const { isAuthResolved, status } = useDashboardSession();
  const authUserId = viewer.authUserId;

  if (status === 'signed_out' || status === 'expired') {
    return (
      <div
        id="tab-panel-collaboration"
        className="dashboard-tab-panel is-active"
        role="tabpanel"
        aria-labelledby="tab-btn-collaboration"
      >
        <div className="bento-grid">
          <DashboardAuthRequiredState
            id="dashboard-collaboration-auth-required"
            title="Sign in to manage collaboration"
            description="Your dashboard session expired or could not be verified. Sign in again to manage collaboration invites and connected creators."
          />
        </div>
      </div>
    );
  }

  return (
    <div
      id="tab-panel-collaboration"
      className="dashboard-tab-panel is-active"
      role="tabpanel"
      aria-labelledby="tab-btn-collaboration"
    >
      <div className="bento-grid">
        <MyCollaboratorsSection authUserId={authUserId} viewerLoading={!isAuthResolved} />
        <StoresICollaborateWithSection authUserId={authUserId} viewerLoading={!isAuthResolved} />
      </div>
    </div>
  );
}

function MyCollaboratorsSection({
  authUserId,
  viewerLoading,
}: {
  authUserId: string | undefined;
  viewerLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const { canRunPanelQueries, markSessionExpired } = useDashboardSession();
  const [invitePanelOpen, setInvitePanelOpen] = useState(false);
  const [generatedInvite, setGeneratedInvite] = useState<{ url: string; expiresAt: number } | null>(
    null
  );
  const [selectedMember, setSelectedMember] = useState<CreatorWorkspaceMemberSummary | null>(null);

  const providersQuery = useQuery(
    dashboardPanelQueryOptions<CollabProviderSummary[]>({
      queryKey: ['dashboard-collab-providers'],
      queryFn: listCollabProviders,
      enabled: canRunPanelQueries && Boolean(authUserId),
    })
  );
  const invitesQuery = useQuery(
    dashboardPollingQueryOptions<PendingCollabInvite[]>({
      queryKey: ['dashboard-collab-invites', authUserId],
      queryFn: () => listCollabInvites(requireAuthUserId(authUserId)),
      enabled: canRunPanelQueries && Boolean(authUserId),
      refetchInterval: 15000,
    })
  );
  const membersQuery = useQuery(
    dashboardPollingQueryOptions<CreatorWorkspaceMemberSummary[]>({
      queryKey: ['dashboard-collab-memberships', authUserId],
      queryFn: () => listCreatorWorkspaceMembers(requireAuthUserId(authUserId)),
      enabled: canRunPanelQueries && Boolean(authUserId),
      refetchInterval: 15000,
    })
  );
  const permissionResourcesQuery = useQuery({
    queryKey: ['dashboard-collab-permission-resources', authUserId],
    queryFn: listCreatorPackagePickerProducts,
    enabled: canRunPanelQueries && Boolean(authUserId) && Boolean(selectedMember),
  });

  useEffect(() => {
    if (
      isDashboardAuthError(providersQuery.error) ||
      isDashboardAuthError(invitesQuery.error) ||
      isDashboardAuthError(membersQuery.error)
    ) {
      markSessionExpired();
    }
  }, [invitesQuery.error, markSessionExpired, membersQuery.error, providersQuery.error]);

  const hasAuthError =
    isDashboardAuthError(providersQuery.error) ||
    isDashboardAuthError(invitesQuery.error) ||
    isDashboardAuthError(membersQuery.error);

  const providers = providersQuery.data ?? [];
  const invites = invitesQuery.data ?? [];
  const members = membersQuery.data ?? [];
  const permissionResources = useMemo<CollaboratorPermissionResource[]>(() => {
    const resources: CollaboratorPermissionResource[] = [];
    for (const group of permissionResourcesQuery.data ?? []) {
      const ownerProducts = group.products.filter(
        (product) => product.accessRole !== 'collaborator'
      );
      for (const product of ownerProducts) {
        resources.push({
          description: product.provider,
          id: product._id,
          label: product.displayName ?? product.productId,
          type: 'product',
        });
      }
      const packageProduct = ownerProducts.find((product) => product.packageId);
      if (packageProduct?.packageId) {
        resources.push({
          description: packageProduct.packageId,
          id: packageProduct.packageId,
          label:
            packageProduct.packageName ?? packageProduct.displayName ?? packageProduct.packageId,
          type: 'package',
        });
      }
    }
    return resources;
  }, [permissionResourcesQuery.data]);

  const providerMap = useMemo(
    () => new Map(providers.map((provider) => [provider.key, provider.label])),
    [providers]
  );

  const generateInviteMutation = useMutation({
    mutationFn: () => createCollabInvite(requireAuthUserId(authUserId), {}),
    onSuccess: async (result) => {
      setGeneratedInvite({ url: result.inviteUrl, expiresAt: result.expiresAt });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard-collab-invites', authUserId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-collab-memberships', authUserId] }),
      ]);
    },
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (inviteId: string) => revokeCollabInvite(requireAuthUserId(authUserId), inviteId),
    onSuccess: async () => {
      setGeneratedInvite(null);
      await queryClient.refetchQueries({ queryKey: ['dashboard-collab-invites', authUserId] });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (membershipId: string) =>
      removeCreatorWorkspaceMember(requireAuthUserId(authUserId), membershipId),
    onSuccess: async () => {
      await queryClient.refetchQueries({
        queryKey: ['dashboard-collab-memberships', authUserId],
      });
    },
  });
  const updatePermissionsMutation = useMutation({
    mutationFn: async (input: {
      member: CreatorWorkspaceMemberSummary;
      grants: CreatorWorkspaceGrant[];
    }) => {
      const policy =
        input.member.permissions ??
        (await getCreatorWorkspaceMemberPermissions(input.member.id)).permissions;
      return await updateCreatorWorkspaceMemberPermissions(input.member.id, {
        expectedRevision: policy.revision,
        grants: input.grants,
      });
    },
    onSuccess: async () => {
      setSelectedMember(null);
      await queryClient.refetchQueries({
        queryKey: ['dashboard-collab-memberships', authUserId],
      });
    },
  });

  const openInvitePanel = () => {
    setInvitePanelOpen(true);
    setGeneratedInvite(null);
  };

  const closeInvitePanel = () => {
    setInvitePanelOpen(false);
  };

  if (hasAuthError) {
    return (
      <DashboardAuthRequiredState
        id="dashboard-my-collaborators-auth-required"
        title="Sign in to manage collaborators"
        description="Your dashboard session expired while loading collaboration data. Sign in again to keep managing collaborator access."
      />
    );
  }

  const isLoading =
    viewerLoading ||
    (canRunPanelQueries &&
      (providersQuery.isLoading || invitesQuery.isLoading || membersQuery.isLoading));

  return (
    <section
      className={`intg-card animate-in bento-col-7${!isLoading ? ' skeleton-loaded' : ''}`}
      id="collab-granted-card"
    >
      <div className="intg-header">
        <div className="intg-title-row">
          {!isLoading ? (
            <div className="intg-icon">
              <Icon name="users" size={18} />
            </div>
          ) : null}
          <h2 className="intg-title">My Collaborators</h2>
        </div>
        <button id="invite-btn" className="intg-add-btn" type="button" onClick={openInvitePanel}>
          <Icon name="link" />
          Invite a Creator
        </button>
      </div>
      <p className="intg-desc" style={isLoading ? { paddingLeft: 0 } : undefined}>
        Invite trusted creators, then grant only the product and package capabilities they need.
      </p>

      <DashboardSkeletonSwap
        isLoading={isLoading}
        skeleton={
          <>
            <DashboardActionRowSkeleton count={1} widths={[132]} />
            <DashboardListSkeleton rows={2} />
          </>
        }
        contentClassName="skeleton-content"
      >
        <DashboardBodyPortal>
          <div className={`inline-panel${invitePanelOpen ? ' open' : ''}`} id="invite-panel">
            <button
              type="button"
              aria-label="Close invite panel"
              onClick={closeInvitePanel}
              style={{
                position: 'absolute',
                inset: 0,
                border: 'none',
                background: 'transparent',
                padding: 0,
              }}
            />
            <div
              className="inline-panel-inner"
              style={{ maxWidth: '440px', position: 'relative', zIndex: 1 }}
            >
              <div className="inline-panel-body">
                <div className="invite-modal-close-row">
                  <button
                    type="button"
                    onClick={closeInvitePanel}
                    className="panel-close-btn"
                    aria-label="Close"
                  >
                    &times;
                  </button>
                </div>

                <div className="invite-modal-header">
                  <div className="intg-icon">
                    <Icon name="link" size={24} />
                  </div>
                  <h3 className="inline-panel-title">Invite a Creator</h3>
                  <p className="inline-panel-desc">
                    Share this link with a trusted creator to add them to your workspace. Everything
                    stays off unless you grant it below.
                  </p>
                </div>

                <div className="rounded-2xl border border-default/40 bg-surface-secondary p-4 dark:border-default/50 dark:bg-surface-secondary">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-foreground dark:text-foreground">
                        Workspace permissions
                      </div>
                      <div className="mt-1 text-xs text-muted dark:text-muted">
                        No access. Everything stays off until you grant it after they join.
                      </div>
                    </div>
                  </div>
                </div>

                {generatedInvite ? (
                  <div className="invite-url-section">
                    <div className="invite-url-row">
                      <div className="invite-url-box" id="invite-url-display">
                        {generatedInvite.url}
                      </div>
                      <button
                        type="button"
                        className="invite-url-copy-btn"
                        aria-label="Copy link"
                        title="Copy link"
                        onClick={() => void copyToClipboard(generatedInvite.url)}
                      >
                        <Icon name="copy" size={16} />
                      </button>
                    </div>
                    <div className="invite-expiry-pill" id="invite-expiry">
                      Expires {formatRelativeDate(generatedInvite.expiresAt)}
                    </div>
                    <div className="invite-modal-actions">
                      <button
                        className="btn-primary"
                        type="button"
                        onClick={() => void copyToClipboard(generatedInvite.url)}
                      >
                        Copy Invite Link
                      </button>
                    </div>
                  </div>
                ) : (
                  <YucpButton
                    id="btn-generate-invite"
                    type="button"
                    yucp="primary"
                    className="invite-generate-btn"
                    isLoading={generateInviteMutation.isPending}
                    onPress={() => generateInviteMutation.mutate()}
                  >
                    Generate Invite Link
                  </YucpButton>
                )}
              </div>
            </div>
          </div>
        </DashboardBodyPortal>

        <div
          id="collab-invites-section"
          className={invites.length > 0 ? '' : 'hidden'}
          style={{ marginBottom: invites.length > 0 ? '24px' : undefined }}
        >
          <div className="collab-section-header">Pending Invites</div>
          <div id="collab-invites-list">
            {invites.map((invite) => (
              <div key={invite.id} className="collab-invite-row">
                <div className="collab-avatar">
                  {(invite.providerKey
                    ? (providerMap.get(invite.providerKey) ?? invite.providerKey)
                    : 'Invite'
                  )
                    .slice(0, 2)
                    .toUpperCase()}
                </div>
                <div className="collab-invite-info">
                  <span className="collab-name">
                    {invite.providerKey
                      ? (providerMap.get(invite.providerKey) ?? invite.providerKey)
                      : 'Workspace invitation'}
                  </span>
                  <span className="collab-invite-expiry">
                    {formatRelativeDate(invite.expiresAt)}
                  </span>
                </div>
                <HoldConfirmButton
                  accessibleLabel="Hold to revoke workspace invitation"
                  isPending={
                    revokeInviteMutation.isPending && revokeInviteMutation.variables === invite.id
                  }
                  onConfirm={() => revokeInviteMutation.mutate(invite.id)}
                  pendingLabel="Revoking..."
                  confirmLabel="Keep holding to revoke"
                >
                  Revoke
                </HoldConfirmButton>
              </div>
            ))}
          </div>
        </div>

        <div
          id="collab-connections-header"
          className={members.length > 0 ? 'collab-section-header' : 'hidden'}
        >
          Workspace collaborators
        </div>
        <div id="collab-list">
          {members.map((member) => (
            <div key={member.id} className="collab-row">
              {member.avatarUrl ? (
                <img src={member.avatarUrl} alt="" className="collab-avatar" />
              ) : (
                <div className="collab-avatar">
                  {member.collaboratorDisplayName.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="collab-name">{member.collaboratorDisplayName}</div>
                <div className="collab-row-meta">
                  {member.provider
                    ? `${providerMap.get(member.provider) ?? member.provider} connection`
                    : 'No store connection shared'}
                </div>
              </div>
              <div className="ml-3 flex shrink-0 flex-wrap items-center justify-end gap-2">
                <YucpButton
                  type="button"
                  yucp="secondary"
                  onPress={() => setSelectedMember(member)}
                >
                  Manage access
                </YucpButton>
                <HoldConfirmButton
                  accessibleLabel={`Hold to remove ${member.collaboratorDisplayName}`}
                  isPending={
                    removeMemberMutation.isPending && removeMemberMutation.variables === member.id
                  }
                  onConfirm={() => removeMemberMutation.mutate(member.id)}
                  pendingLabel="Removing..."
                  confirmLabel="Keep holding to remove"
                >
                  Remove
                </HoldConfirmButton>
              </div>
            </div>
          ))}
        </div>

        <CollaboratorPermissionSheet
          description={`Configure access for ${selectedMember?.collaboratorDisplayName ?? 'this collaborator'}. Each capability can target a different set of resources.`}
          initialGrants={selectedMember?.permissions?.grants ?? []}
          isOpen={Boolean(selectedMember)}
          isSaving={updatePermissionsMutation.isPending}
          legacyPolicyPendingReview={
            selectedMember?.permissions?.legacyPolicyPendingReview ?? false
          }
          onOpenChange={(open) => {
            if (!open && !updatePermissionsMutation.isPending) {
              setSelectedMember(null);
            }
          }}
          onSave={(grants) => {
            if (selectedMember) {
              updatePermissionsMutation.mutate({ member: selectedMember, grants });
            }
          }}
          resources={permissionResources}
          title="Collaborator permissions"
        />

        {invites.length === 0 && members.length === 0 ? (
          <div id="collab-empty" className="empty-state">
            <div className="intg-icon" style={{ margin: '0 auto 14px' }}>
              <Icon name="users" size={18} />
            </div>
            <p className="empty-state-title">No collaborators yet.</p>
            <p className="empty-state-copy">
              Invite a creator, then grant only the access they need.
            </p>
            <button
              className="intg-add-btn"
              type="button"
              onClick={openInvitePanel}
              style={{ marginTop: '16px' }}
            >
              <Icon name="link" />
              Invite a Creator
            </button>
          </div>
        ) : null}
      </DashboardSkeletonSwap>
    </section>
  );
}

function StoresICollaborateWithSection({
  authUserId,
  viewerLoading,
}: {
  authUserId: string | undefined;
  viewerLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const { canRunPanelQueries, markSessionExpired } = useDashboardSession();
  const [removeError, setRemoveError] = useState<string | null>(null);
  const storesQuery = useQuery(
    dashboardPollingQueryOptions<CollabAsCollaboratorSummary[]>({
      queryKey: ['dashboard-collab-as-collaborator', authUserId],
      queryFn: () => listCollabConnectionsAsCollaborator(requireAuthUserId(authUserId)),
      enabled: canRunPanelQueries && Boolean(authUserId),
      refetchInterval: 15000,
    })
  );

  useEffect(() => {
    if (isDashboardAuthError(storesQuery.error)) {
      markSessionExpired();
    }
  }, [markSessionExpired, storesQuery.error]);

  const removeStoreMutation = useMutation({
    mutationFn: (connectionId: string) =>
      removeCollabConnectionAsCollaborator(requireAuthUserId(authUserId), connectionId),
    onMutate: () => {
      setRemoveError(null);
    },
    onSuccess: async () => {
      await queryClient.refetchQueries({
        queryKey: ['dashboard-collab-as-collaborator', authUserId],
      });
    },
    onError: (error) => {
      setRemoveError(
        error instanceof Error ? error.message : 'Could not leave this store right now.'
      );
    },
  });

  if (isDashboardAuthError(storesQuery.error)) {
    return (
      <DashboardAuthRequiredState
        id="dashboard-stores-collab-auth-required"
        title="Sign in to view collaborator stores"
        description="Your dashboard session expired while loading stores you collaborate with. Sign in again to continue."
      />
    );
  }

  const stores = storesQuery.data ?? [];
  const isLoading = viewerLoading || (canRunPanelQueries && storesQuery.isLoading);

  return (
    <section
      className={`intg-card animate-in bento-col-5${!isLoading ? ' skeleton-loaded' : ''}`}
      id="collab-as-collab-card"
    >
      <div className="intg-header">
        <div className="intg-title-row">
          {!isLoading ? (
            <div className="intg-icon">
              <Icon name="home" size={18} />
            </div>
          ) : null}
          <h2 className="intg-title">Stores I Collaborate With</h2>
        </div>
      </div>
      <p className="intg-desc" style={isLoading ? { paddingLeft: 0 } : undefined}>
        Stores where you&apos;ve been granted creator access to verify licenses. Hold the leave
        button to disconnect access.
      </p>

      <DashboardSkeletonSwap
        isLoading={isLoading}
        skeleton={<DashboardListSkeleton rows={1} showAction={false} />}
        contentClassName="skeleton-content"
      >
        <div id="collab-as-collaborator-list">
          {stores.map((store) => (
            <div key={store.id} className="collab-row">
              <div className="collab-avatar">
                {(store.ownerDisplayName ?? store.ownerAuthUserId).slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="collab-name">{store.ownerDisplayName ?? 'Creator Store'}</div>
                <div className="collab-row-meta">
                  {store.provider} &middot; {store.linkType} &middot; Connected{' '}
                  {formatRelativeDate(store.createdAt)}
                </div>
              </div>
              <div className="ml-3 flex shrink-0 items-center">
                <HoldConfirmButton
                  accessibleLabel={`Hold to remove ${store.ownerDisplayName ?? 'Creator Store'}`}
                  duration={900}
                  isPending={
                    removeStoreMutation.isPending && removeStoreMutation.variables === store.id
                  }
                  onConfirm={() => removeStoreMutation.mutate(store.id)}
                  pendingLabel="Leaving..."
                  confirmLabel="Keep holding..."
                >
                  <Icon name="trash" size={14} aria-hidden="true" />
                  Hold to leave
                </HoldConfirmButton>
              </div>
            </div>
          ))}
        </div>

        {removeError ? (
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-danger/20 bg-danger/8 px-3 py-2 text-xs font-medium text-danger"
          >
            {removeError}
          </div>
        ) : null}

        {stores.length === 0 ? (
          <div id="collab-as-collaborator-empty" className="empty-state">
            <div className="intg-icon" style={{ margin: '0 auto 14px' }}>
              <Icon name="home" size={18} />
            </div>
            <p className="empty-state-title">Not collaborating yet.</p>
            <p className="empty-state-copy">
              Accept an invite from another creator to appear here.
            </p>
          </div>
        ) : null}
      </DashboardSkeletonSwap>
    </section>
  );
}

function formatRelativeDate(timestamp: number) {
  const diff = timestamp - Date.now();
  const absMinutes = Math.round(Math.abs(diff) / 60000);

  if (absMinutes < 60) {
    return diff >= 0 ? `in ${absMinutes}m` : `${absMinutes}m ago`;
  }

  const absHours = Math.round(absMinutes / 60);
  if (absHours < 48) {
    return diff >= 0 ? `in ${absHours}h` : `${absHours}h ago`;
  }

  const absDays = Math.round(absHours / 24);
  return diff >= 0 ? `in ${absDays}d` : `${absDays}d ago`;
}

function requireAuthUserId(authUserId: string | undefined) {
  if (!authUserId) {
    throw new Error('Not authenticated');
  }

  return authUserId;
}
