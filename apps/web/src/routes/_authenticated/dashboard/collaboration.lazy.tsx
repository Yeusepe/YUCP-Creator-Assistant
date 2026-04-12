import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createLazyFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { DashboardBodyPortal } from '@/components/dashboard/DashboardBodyPortal';
import {
  DashboardActionRowSkeleton,
  DashboardListSkeleton,
} from '@/components/dashboard/DashboardSkeletons';
import { Select } from '@/components/ui/Select';
import { YucpButton } from '@/components/ui/YucpButton';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import { useDashboardShell } from '@/hooks/useDashboardShell';
import type {
  CollabAsCollaboratorSummary,
  CollabConnectionSummary,
  CollabProviderSummary,
  PendingCollabInvite,
} from '@/lib/dashboard';
import {
  createCollabInvite,
  listCollabConnections,
  listCollabConnectionsAsCollaborator,
  listCollabInvites,
  listCollabProviders,
  removeCollabConnection,
  revokeCollabInvite,
} from '@/lib/dashboard';
import {
  dashboardPanelQueryOptions,
  dashboardPollingQueryOptions,
} from '@/lib/dashboardQueryOptions';
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
  const [selectedProvider, setSelectedProvider] = useState('');
  const [generatedInvite, setGeneratedInvite] = useState<{ url: string; expiresAt: number } | null>(
    null
  );
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);

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
  const connectionsQuery = useQuery(
    dashboardPollingQueryOptions<CollabConnectionSummary[]>({
      queryKey: ['dashboard-collab-connections', authUserId],
      queryFn: () => listCollabConnections(requireAuthUserId(authUserId)),
      enabled: canRunPanelQueries && Boolean(authUserId),
      refetchInterval: 15000,
    })
  );

  useEffect(() => {
    if (
      isDashboardAuthError(providersQuery.error) ||
      isDashboardAuthError(invitesQuery.error) ||
      isDashboardAuthError(connectionsQuery.error)
    ) {
      markSessionExpired();
    }
  }, [connectionsQuery.error, invitesQuery.error, markSessionExpired, providersQuery.error]);

  const hasAuthError =
    isDashboardAuthError(providersQuery.error) ||
    isDashboardAuthError(invitesQuery.error) ||
    isDashboardAuthError(connectionsQuery.error);

  const providers = providersQuery.data ?? [];
  const invites = invitesQuery.data ?? [];
  const connections = connectionsQuery.data ?? [];

  const providerMap = useMemo(
    () => new Map(providers.map((provider) => [provider.key, provider.label])),
    [providers]
  );

  const generateInviteMutation = useMutation({
    mutationFn: () =>
      createCollabInvite(requireAuthUserId(authUserId), { providerKey: selectedProvider }),
    onSuccess: async (result) => {
      setGeneratedInvite({ url: result.inviteUrl, expiresAt: result.expiresAt });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard-collab-invites', authUserId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-collab-connections', authUserId] }),
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

  const removeConnectionMutation = useMutation({
    mutationFn: (connectionId: string) =>
      removeCollabConnection(requireAuthUserId(authUserId), connectionId),
    onSuccess: async () => {
      await queryClient.refetchQueries({
        queryKey: ['dashboard-collab-connections', authUserId],
      });
    },
  });

  const handleProviderChange = (key: string) => {
    setSelectedProvider(key);
    const existing = invites.find((i) => i.providerKey === key);
    if (existing) {
      setGeneratedInvite({
        url: `${window.location.origin}/collab-invite?id=${encodeURIComponent(existing.id)}`,
        expiresAt: existing.expiresAt,
      });
    } else {
      setGeneratedInvite(null);
    }
  };

  const openInvitePanel = () => {
    const providerKey = selectedProvider || providers[0]?.key || '';
    setSelectedProvider(providerKey);
    setInvitePanelOpen(true);

    const existingInvite = invites.find((i) => i.providerKey === providerKey);
    if (existingInvite) {
      setGeneratedInvite({
        url: `${window.location.origin}/collab-invite?id=${encodeURIComponent(existingInvite.id)}`,
        expiresAt: existingInvite.expiresAt,
      });
    } else {
      setGeneratedInvite(null);
    }
  };

  const closeInvitePanel = () => {
    setInvitePanelOpen(false);
  };

  const handleCopyInviteLink = (url: string, inviteId: string) => {
    void copyToClipboard(url);
    setCopiedInviteId(inviteId);
    setTimeout(() => setCopiedInviteId(null), 1500);
  };

  const currentInviteId = invites.find((i) => i.providerKey === selectedProvider)?.id;

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
      (providersQuery.isLoading || invitesQuery.isLoading || connectionsQuery.isLoading));

  return (
    <section
      className={`intg-card animate-in bento-col-7${!isLoading ? ' skeleton-loaded' : ''}`}
      id="collab-granted-card"
    >
      <div className="intg-header">
        <div className="intg-title-row">
          {!isLoading ? (
            <div className="intg-icon">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
          ) : null}
          <h2 className="intg-title">My Collaborators</h2>
        </div>
        <button id="invite-btn" className="intg-add-btn" type="button" onClick={openInvitePanel}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          Invite a Creator
        </button>
      </div>
      <p className="intg-desc" style={isLoading ? { paddingLeft: 0 } : undefined}>
        Allow members to verify licenses from other creators&apos; stores.
      </p>

      <DashboardActionRowSkeleton count={1} widths={[132]} />
      <DashboardListSkeleton rows={2} />

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
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                </div>
                <h3 className="inline-panel-title">Invite a Creator</h3>
                <p className="inline-panel-desc">
                  Share this link with a trusted creator to allow them to link their stores and
                  products to your server.
                </p>
              </div>

              <div className="modal-field">
                <label className="modal-label" htmlFor="invite-provider-select">
                  Store Platform
                </label>
                <Select
                  id="invite-provider-select"
                  value={selectedProvider}
                  onChange={handleProviderChange}
                  options={providers.map((p) => ({ value: p.key, label: p.label }))}
                />
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
                      <svg
                        viewBox="0 0 24 24"
                        width="16"
                        height="16"
                        fill="none"
                        aria-hidden="true"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
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
                    {currentInviteId ? (
                      <button
                        type="button"
                        className={`collab-remove-btn${revokeInviteMutation.isPending ? ' btn-loading' : ''}`}
                        style={{ marginLeft: 0, width: '100%', justifyContent: 'center' }}
                        disabled={revokeInviteMutation.isPending}
                        onClick={() =>
                          currentInviteId && revokeInviteMutation.mutate(currentInviteId)
                        }
                      >
                        {revokeInviteMutation.isPending ? (
                          <>
                            <span className="btn-loading-spinner" aria-hidden="true" />
                            Revoking...
                          </>
                        ) : (
                          'Revoke Invite'
                        )}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <YucpButton
                  id="btn-generate-invite"
                  type="button"
                  yucp="primary"
                  className="invite-generate-btn"
                  isDisabled={!selectedProvider}
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

      {!isLoading ? (
        <div className="skeleton-content">
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
                    {(providerMap.get(invite.providerKey) ?? invite.providerKey)
                      .slice(0, 2)
                      .toUpperCase()}
                  </div>
                  <div className="collab-invite-info">
                    <span className="collab-name">
                      {providerMap.get(invite.providerKey) ?? invite.providerKey}
                    </span>
                    <span className="collab-invite-expiry">
                      {formatRelativeDate(invite.expiresAt)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={`collab-copy-btn${copiedInviteId === invite.id ? ' copied' : ''}`}
                    onClick={() =>
                      handleCopyInviteLink(
                        `${window.location.origin}/collab-invite?id=${encodeURIComponent(invite.id)}`,
                        invite.id
                      )
                    }
                  >
                    {copiedInviteId === invite.id ? 'Copied!' : 'Copy link'}
                  </button>
                  <button
                    type="button"
                    className={`collab-remove-btn${revokeInviteMutation.isPending && revokeInviteMutation.variables === invite.id ? ' btn-loading' : ''}`}
                    disabled={
                      revokeInviteMutation.isPending && revokeInviteMutation.variables === invite.id
                    }
                    onClick={() => revokeInviteMutation.mutate(invite.id)}
                  >
                    {revokeInviteMutation.isPending &&
                    revokeInviteMutation.variables === invite.id ? (
                      <>
                        <span className="btn-loading-spinner" aria-hidden="true" />
                        Revoking...
                      </>
                    ) : (
                      'Revoke'
                    )}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div
            id="collab-connections-header"
            className={connections.length > 0 ? 'collab-section-header' : 'hidden'}
          >
            Active Connections
          </div>
          <div id="collab-list">
            {connections.map((connection) => (
              <div key={connection.id} className="collab-row">
                {connection.avatarUrl ? (
                  <img src={connection.avatarUrl} alt="" className="collab-avatar" />
                ) : (
                  <div className="collab-avatar">
                    {(connection.collaboratorDisplayName ?? connection.source)
                      .slice(0, 2)
                      .toUpperCase()}
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="collab-name">
                    {connection.collaboratorDisplayName ?? connection.source}
                  </div>
                  <div className="collab-row-meta">
                    {providerMap.get(connection.provider) ?? connection.provider} &middot;{' '}
                    {connection.linkType} &middot;{' '}
                    {connection.webhookConfigured ? 'Webhook ready' : 'Webhook pending'}
                  </div>
                </div>
                <button
                  type="button"
                  className={`collab-remove-btn${removeConnectionMutation.isPending && removeConnectionMutation.variables === connection.id ? ' btn-loading' : ''}`}
                  disabled={
                    removeConnectionMutation.isPending &&
                    removeConnectionMutation.variables === connection.id
                  }
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Remove ${connection.collaboratorDisplayName ?? connection.source} from your collaboration list?`
                      )
                    ) {
                      return;
                    }
                    removeConnectionMutation.mutate(connection.id);
                  }}
                >
                  {removeConnectionMutation.isPending &&
                  removeConnectionMutation.variables === connection.id ? (
                    <>
                      <span className="btn-loading-spinner" aria-hidden="true" />
                      Removing...
                    </>
                  ) : (
                    'Remove'
                  )}
                </button>
              </div>
            ))}
          </div>

          {invites.length === 0 && connections.length === 0 ? (
            <div id="collab-empty" className="empty-state">
              <div className="intg-icon" style={{ margin: '0 auto 14px' }}>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <p className="empty-state-title">No collaborators yet.</p>
              <p className="empty-state-copy">Invite a creator to share license verification.</p>
              <button
                className="intg-add-btn"
                type="button"
                onClick={openInvitePanel}
                style={{ marginTop: '16px' }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                Invite a Creator
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
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
  const { canRunPanelQueries, markSessionExpired } = useDashboardSession();
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
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </div>
          ) : null}
          <h2 className="intg-title">Stores I Collaborate With</h2>
        </div>
      </div>
      <p className="intg-desc" style={isLoading ? { paddingLeft: 0 } : undefined}>
        Stores where you&apos;ve been granted creator access to verify licenses.
      </p>

      <DashboardListSkeleton rows={1} showAction={false} />

      {!isLoading ? (
        <div className="skeleton-content">
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
              </div>
            ))}
          </div>

          {stores.length === 0 ? (
            <div id="collab-as-collaborator-empty" className="empty-state">
              <div className="intg-icon" style={{ margin: '0 auto 14px' }}>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </svg>
              </div>
              <p className="empty-state-title">Not collaborating yet.</p>
              <p className="empty-state-copy">
                Accept an invite from another creator to appear here.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
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
