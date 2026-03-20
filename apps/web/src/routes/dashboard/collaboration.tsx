import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { DashboardBodyPortal } from '@/components/dashboard/DashboardBodyPortal';
import {
  DashboardActionRowSkeleton,
  DashboardListSkeleton,
} from '@/components/dashboard/DashboardSkeletons';
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
import { dashboardPollingQueryOptions, dashboardQueryOptions } from '@/lib/dashboardQueryOptions';
import { type DashboardViewer, fetchDashboardViewer } from '@/lib/server/dashboard';
import { copyToClipboard } from '@/lib/utils';

export const Route = createFileRoute('/dashboard/collaboration')({
  component: DashboardCollaboration,
});

function DashboardCollaboration() {
  const viewerQuery = useQuery(
    dashboardQueryOptions<DashboardViewer>({
      queryKey: ['dashboard-viewer'],
      queryFn: () => fetchDashboardViewer(),
    })
  );
  const authUserId = viewerQuery.data?.authUserId;

  if (!viewerQuery.isLoading && !authUserId) {
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
        <MyCollaboratorsSection authUserId={authUserId} viewerLoading={viewerQuery.isLoading} />
        <StoresICollaborateWithSection
          authUserId={authUserId}
          viewerLoading={viewerQuery.isLoading}
        />
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
  const [invitePanelOpen, setInvitePanelOpen] = useState(false);
  const [inviteStep, setInviteStep] = useState<'select' | 'url'>('select');
  const [selectedProvider, setSelectedProvider] = useState('');
  const [generatedInvite, setGeneratedInvite] = useState<{ url: string; expiresAt: number } | null>(
    null
  );

  const providersQuery = useQuery(
    dashboardQueryOptions<CollabProviderSummary[]>({
      queryKey: ['dashboard-collab-providers'],
      queryFn: listCollabProviders,
      enabled: Boolean(authUserId),
    })
  );
  const invitesQuery = useQuery(
    dashboardPollingQueryOptions<PendingCollabInvite[]>({
      queryKey: ['dashboard-collab-invites', authUserId],
      queryFn: () => listCollabInvites(requireAuthUserId(authUserId)),
      enabled: Boolean(authUserId),
      refetchInterval: 15000,
    })
  );
  const connectionsQuery = useQuery(
    dashboardPollingQueryOptions<CollabConnectionSummary[]>({
      queryKey: ['dashboard-collab-connections', authUserId],
      queryFn: () => listCollabConnections(requireAuthUserId(authUserId)),
      enabled: Boolean(authUserId),
      refetchInterval: 15000,
    })
  );

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
      setInviteStep('url');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard-collab-invites', authUserId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-collab-connections', authUserId] }),
      ]);
    },
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (inviteId: string) => revokeCollabInvite(requireAuthUserId(authUserId), inviteId),
    onSuccess: async () => {
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

  const openInvitePanel = () => {
    const defaultProvider = selectedProvider || providers[0]?.key || '';
    const providerKey = defaultProvider;
    setSelectedProvider(providerKey);
    setInvitePanelOpen(true);

    // If there's an existing pending invite for this provider, show it instead of
    // resetting — prevents auto-revoking still-valid invites when re-opening the panel.
    const existingInvite = invites.find((i) => i.providerKey === providerKey);
    if (existingInvite) {
      setGeneratedInvite({
        url: `${window.location.origin}/collab-invite?id=${encodeURIComponent(existingInvite.id)}`,
        expiresAt: existingInvite.expiresAt,
      });
      setInviteStep('url');
    } else {
      setInviteStep('select');
      setGeneratedInvite(null);
    }
  };

  const closeInvitePanel = () => {
    setInvitePanelOpen(false);
    setInviteStep('select');
  };

  const messageTemplate = generatedInvite
    ? `Hey, here's the Creator Assistant collaboration link for ${providerMap.get(selectedProvider) ?? selectedProvider}: ${generatedInvite.url}`
    : '';

  const isLoading =
    viewerLoading ||
    providersQuery.isLoading ||
    invitesQuery.isLoading ||
    connectionsQuery.isLoading;

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
            style={{ maxWidth: '500px', position: 'relative', zIndex: 1 }}
          >
            <div className="inline-panel-body" style={{ padding: '32px', textAlign: 'center' }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '-24px' }}>
                <button
                  type="button"
                  onClick={closeInvitePanel}
                  className="panel-close-btn"
                  aria-label="Close"
                >
                  &times;
                </button>
              </div>
              <div
                className="intg-icon"
                style={{
                  margin: '0 auto 16px',
                  width: '48px',
                  height: '48px',
                  background: 'rgba(14, 165, 233, 0.15)',
                  color: '#0ea5e9',
                  border: '1px solid rgba(14, 165, 233, 0.3)',
                }}
              >
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
              <h3
                style={{
                  fontSize: '22px',
                  fontWeight: 800,
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                  color: '#fff',
                  margin: '0 0 8px',
                }}
              >
                Invite a Creator
              </h3>
              <p
                id="invite-panel-desc"
                style={{
                  fontSize: '14px',
                  color: 'rgba(255,255,255,0.7)',
                  margin: '0 0 24px',
                  lineHeight: 1.5,
                }}
              >
                Share this link with a trusted creator to allow them to link their stores and
                products to your server.
              </p>

              <div
                id="invite-step-select"
                style={{ display: inviteStep === 'select' ? undefined : 'none' }}
              >
                <div style={{ textAlign: 'left', marginBottom: '16px' }}>
                  <label
                    htmlFor="invite-provider-select"
                    style={{
                      display: 'block',
                      fontSize: '12px',
                      fontWeight: 700,
                      color: 'rgba(255,255,255,0.5)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      marginBottom: '8px',
                    }}
                  >
                    Store Platform
                  </label>
                  <select
                    id="invite-provider-select"
                    className="invite-provider-pick"
                    value={selectedProvider}
                    onChange={(event) => {
                      const key = event.target.value;
                      setSelectedProvider(key);
                      const existing = invites.find((i) => i.providerKey === key);
                      if (existing) {
                        setGeneratedInvite({
                          url: `${window.location.origin}/collab-invite?id=${encodeURIComponent(existing.id)}`,
                          expiresAt: existing.expiresAt,
                        });
                        setInviteStep('url');
                      } else {
                        setGeneratedInvite(null);
                        setInviteStep('select');
                      }
                    }}
                  >
                    {providers.map((provider) => (
                      <option key={provider.key} value={provider.key}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  id="btn-generate-invite"
                  type="button"
                  disabled={!selectedProvider || generateInviteMutation.isPending}
                  onClick={() => generateInviteMutation.mutate()}
                  style={primaryFullWidthButtonStyle}
                >
                  {generateInviteMutation.isPending ? 'Generating…' : 'Generate Invite Link'}
                </button>
              </div>

              <div
                id="invite-step-url"
                style={{ display: inviteStep === 'url' ? undefined : 'none' }}
              >
                <div className="invite-url-row">
                  <div
                    className="invite-url-box"
                    id="invite-url-display"
                    style={{ marginBottom: 0 }}
                  >
                    {generatedInvite?.url}
                  </div>
                  <button
                    type="button"
                    className="invite-url-copy-btn"
                    aria-label="Copy link"
                    title="Copy link"
                    onClick={() => generatedInvite && void copyToClipboard(generatedInvite.url)}
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
                <div
                  id="invite-expiry"
                  style={{
                    marginTop: '10px',
                    fontSize: '13px',
                    fontWeight: 500,
                    color: '#38bdf8',
                    marginBottom: '16px',
                  }}
                >
                  Expires {generatedInvite ? formatRelativeDate(generatedInvite.expiresAt) : ''}
                </div>

                <div
                  style={{
                    textAlign: 'left',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    marginBottom: '20px',
                  }}
                >
                  <div
                    style={{
                      display: 'block',
                      fontSize: '12px',
                      fontWeight: 700,
                      color: 'rgba(255,255,255,0.5)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      marginBottom: '8px',
                    }}
                  >
                    Message Template
                  </div>
                  <textarea
                    id="invite-message-template"
                    readOnly
                    value={messageTemplate}
                    style={{
                      width: '100%',
                      height: '80px',
                      background: 'transparent',
                      border: 'none',
                      color: 'rgba(255,255,255,0.9)',
                      fontSize: '14px',
                      fontFamily: "'DM Sans', sans-serif",
                      resize: 'none',
                      outline: 'none',
                      lineHeight: 1.5,
                    }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
                    <button
                      type="button"
                      style={copyTemplateButtonStyle}
                      onClick={() => void copyToClipboard(messageTemplate)}
                    >
                      Copy template
                    </button>
                  </div>
                </div>

                <button
                  className="btn-primary"
                  type="button"
                  onClick={() => generatedInvite && void copyToClipboard(generatedInvite.url)}
                  style={primaryFullWidthButtonStyle}
                >
                  Copy Invite Link
                </button>
              </div>
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
                    className="btn-ghost"
                    onClick={() =>
                      void copyToClipboard(
                        `${window.location.origin}/collab-invite?id=${encodeURIComponent(invite.id)}`
                      )
                    }
                  >
                    Copy link
                  </button>
                  <button
                    type="button"
                    className="collab-remove-btn"
                    disabled={
                      revokeInviteMutation.isPending && revokeInviteMutation.variables === invite.id
                    }
                    onClick={() => revokeInviteMutation.mutate(invite.id)}
                  >
                    Revoke
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
                  <div
                    style={{
                      fontSize: '12px',
                      color: 'var(--text-secondary)',
                      fontFamily: "'DM Sans',sans-serif",
                      marginTop: '2px',
                    }}
                  >
                    {providerMap.get(connection.provider) ?? connection.provider} ·{' '}
                    {connection.linkType} ·{' '}
                    {connection.webhookConfigured ? 'Webhook ready' : 'Webhook pending'}
                  </div>
                </div>
                <button
                  type="button"
                  className="collab-remove-btn"
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
                  Remove
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
  const storesQuery = useQuery(
    dashboardPollingQueryOptions<CollabAsCollaboratorSummary[]>({
      queryKey: ['dashboard-collab-as-collaborator', authUserId],
      queryFn: () => listCollabConnectionsAsCollaborator(requireAuthUserId(authUserId)),
      enabled: Boolean(authUserId),
      refetchInterval: 15000,
    })
  );

  const stores = storesQuery.data ?? [];
  const isLoading = viewerLoading || storesQuery.isLoading;

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
                  <div
                    style={{
                      fontSize: '12px',
                      color: 'var(--text-secondary)',
                      fontFamily: "'DM Sans',sans-serif",
                      marginTop: '2px',
                    }}
                  >
                    {store.provider} · {store.linkType} · Connected{' '}
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

const primaryFullWidthButtonStyle = {
  width: '100%',
  padding: '12px 24px',
  background: '#0ea5e9',
  color: '#fff',
  border: 'none',
  borderRadius: '12px',
  fontSize: '15px',
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: "'DM Sans', sans-serif",
} satisfies React.CSSProperties;

const copyTemplateButtonStyle = {
  background: 'none',
  border: 'none',
  color: '#0ea5e9',
  fontSize: '13px',
  fontWeight: 700,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '4px 8px',
  borderRadius: '6px',
  transition: 'background 0.15s',
} satisfies React.CSSProperties;
