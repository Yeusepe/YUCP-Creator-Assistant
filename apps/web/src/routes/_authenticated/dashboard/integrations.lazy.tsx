import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createLazyFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { DashboardBodyPortal } from '@/components/dashboard/DashboardBodyPortal';
import { DashboardSkeletonSwap } from '@/components/dashboard/DashboardSkeletonSwap';
import {
  DashboardActionRowSkeleton,
  DashboardListSkeleton,
} from '@/components/dashboard/DashboardSkeletons';
import { isDashboardAuthError, useDashboardSession } from '@/hooks/useDashboardSession';
import { useDashboardShell } from '@/hooks/useDashboardShell';
import type {
  CreatedOAuthApp,
  CreatedPublicApiKey,
  OAuthAppSummary,
  PublicApiKeySummary,
} from '@/lib/dashboard';
import {
  createOAuthApp,
  createPublicApiKey,
  deleteOAuthApp,
  listOAuthApps,
  listPublicApiKeys,
  regenerateOAuthAppSecret,
  revokePublicApiKey,
  rotatePublicApiKey,
  updateOAuthApp,
} from '@/lib/dashboard';
import { dashboardPanelQueryOptions } from '@/lib/dashboardQueryOptions';
import { copyToClipboard } from '@/lib/utils';

function DashboardIntegrationsPending() {
  return (
    <div
      id="tab-panel-integrations"
      className="dashboard-tab-panel is-active"
      role="tabpanel"
      aria-labelledby="tab-btn-integrations"
    >
      <div className="bento-grid integrations-grid">
        <DashboardListSkeleton rows={2} />
        <DashboardListSkeleton rows={2} />
      </div>
    </div>
  );
}

export const Route = createLazyFileRoute('/_authenticated/dashboard/integrations')({
  pendingComponent: DashboardIntegrationsPending,
  component: DashboardIntegrations,
});

const OAUTH_SCOPE_OPTIONS = [
  {
    key: 'verification:read',
    name: 'verification:read',
    description: 'Check if a user is verified on your server',
  },
  {
    key: 'subjects:read',
    name: 'subjects:read',
    description: 'Read verified users and purchase records',
  },
  {
    key: 'products:read',
    name: 'products:read',
    description: 'Read product catalog for package imports',
  },
] as const;

function DashboardIntegrations() {
  const { viewer } = useDashboardShell();
  const { isAuthResolved, status } = useDashboardSession();
  const authUserId = viewer.authUserId;

  if (status === 'signed_out' || status === 'expired') {
    return (
      <div
        id="tab-panel-integrations"
        className="dashboard-tab-panel is-active"
        role="tabpanel"
        aria-labelledby="tab-btn-integrations"
      >
        <div className="bento-grid integrations-grid">
          <DashboardAuthRequiredState
            id="dashboard-integrations-auth-required"
            title="Sign in to manage developer integrations"
            description="Your dashboard session expired or could not be verified. Sign in again to manage OAuth apps and API keys."
          />
        </div>
      </div>
    );
  }

  return (
    <div
      id="tab-panel-integrations"
      className="dashboard-tab-panel is-active"
      role="tabpanel"
      aria-labelledby="tab-btn-integrations"
    >
      <div className="bento-grid integrations-grid">
        <OAuthAppsSection authUserId={authUserId} viewerLoading={!isAuthResolved} />
        <ApiKeysSection authUserId={authUserId} viewerLoading={!isAuthResolved} />
      </div>
    </div>
  );
}

function OAuthAppsSection({
  authUserId,
  viewerLoading,
}: {
  authUserId: string | undefined;
  viewerLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const { canRunPanelQueries, markSessionExpired } = useDashboardSession();
  const [createPanelOpen, setCreatePanelOpen] = useState(false);
  const [appName, setAppName] = useState('');
  const [redirectUris, setRedirectUris] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>(['verification:read']);
  const [editingAppId, setEditingAppId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingRedirectUris, setEditingRedirectUris] = useState('');
  const [editingScopes, setEditingScopes] = useState<string[]>([]);
  const [revealedSecret, setRevealedSecret] = useState<CreatedOAuthApp | null>(null);

  const oauthAppsQuery = useQuery(
    dashboardPanelQueryOptions<OAuthAppSummary[]>({
      queryKey: ['dashboard-oauth-apps', authUserId],
      queryFn: () => listOAuthApps(requireAuthUserId(authUserId)),
      enabled: canRunPanelQueries && Boolean(authUserId),
    })
  );

  useEffect(() => {
    if (isDashboardAuthError(oauthAppsQuery.error)) {
      markSessionExpired();
    }
  }, [markSessionExpired, oauthAppsQuery.error]);

  const hasAuthError = isDashboardAuthError(oauthAppsQuery.error);

  const resetCreateForm = useCallback(() => {
    setAppName('');
    setRedirectUris('');
    setSelectedScopes(['verification:read']);
    setCreatePanelOpen(false);
  }, []);

  const createMutation = useMutation({
    mutationFn: () =>
      createOAuthApp(requireAuthUserId(authUserId), {
        name: appName.trim(),
        redirectUris: parseMultilineValues(redirectUris),
        scopes: selectedScopes,
      }),
    onSuccess: async (created) => {
      setRevealedSecret(created);
      resetCreateForm();
      await queryClient.invalidateQueries({ queryKey: ['dashboard-oauth-apps', authUserId] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (appId: string) =>
      updateOAuthApp(requireAuthUserId(authUserId), appId, {
        name: editingName.trim(),
        redirectUris: parseMultilineValues(editingRedirectUris),
        scopes: editingScopes,
      }),
    onSuccess: async () => {
      setEditingAppId(null);
      await queryClient.invalidateQueries({ queryKey: ['dashboard-oauth-apps', authUserId] });
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: async (app: OAuthAppSummary) => {
      const result = await regenerateOAuthAppSecret(requireAuthUserId(authUserId), app._id);
      return {
        appId: app._id,
        clientId: app.clientId,
        clientSecret: result.clientSecret,
        name: app.name,
        redirectUris: app.redirectUris,
        scopes: app.scopes,
      } satisfies CreatedOAuthApp;
    },
    onSuccess: async (revealed) => {
      setRevealedSecret(revealed);
      await queryClient.invalidateQueries({ queryKey: ['dashboard-oauth-apps', authUserId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (appId: string) => deleteOAuthApp(requireAuthUserId(authUserId), appId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['dashboard-oauth-apps', authUserId] });
    },
  });

  const openEditPanel = useCallback((app: OAuthAppSummary) => {
    setEditingAppId(app._id);
    setEditingName(app.name);
    setEditingRedirectUris(app.redirectUris.join('\n'));
    setEditingScopes(app.scopes);
  }, []);

  if (hasAuthError) {
    return (
      <DashboardAuthRequiredState
        id="dashboard-oauth-apps-auth-required"
        title="Sign in to manage OAuth applications"
        description="Your dashboard session expired while loading OAuth apps. Sign in again to keep managing developer integrations."
      />
    );
  }

  const isLoading = viewerLoading || (canRunPanelQueries && oauthAppsQuery.isLoading);
  const apps = oauthAppsQuery.data ?? [];

  return (
    <section
      className="intg-card bento-col-6 animate-in animate-in-delay-5"
      id="oauth-apps-section"
    >
      <div className="intg-header">
        <div className="intg-title-row">
          {!isLoading ? (
            <div className="intg-icon">
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
          ) : null}
          <div className="intg-copy developer-intg-copy">
            <h2 className="intg-title">OAuth Applications</h2>
            <p className="intg-desc">
              Register apps that use the OAuth 2.0 flow to access user verification data on their
              behalf.
            </p>
          </div>
        </div>
        <button
          id="create-oauth-app-btn"
          className="intg-add-btn"
          type="button"
          onClick={() => setCreatePanelOpen(true)}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add app
        </button>
      </div>

      <InlineOAuthAppForm
        open={createPanelOpen}
        title="Register OAuth app"
        submitLabel={createMutation.isPending ? 'Registering…' : 'Register app'}
        name={appName}
        redirectUris={redirectUris}
        selectedScopes={selectedScopes}
        onClose={() => setCreatePanelOpen(false)}
        onNameChange={setAppName}
        onRedirectUrisChange={setRedirectUris}
        onScopeToggle={(scope) => setSelectedScopes((current) => toggleScope(current, scope))}
        onSubmit={() => createMutation.mutate()}
      />

      {revealedSecret ? (
        <CredentialRevealCard
          id="oauth-secret-reveal"
          title={revealedSecret.name}
          subtitle="Save this client secret now. It will not be shown again."
          fields={[
            { label: 'Client ID', value: revealedSecret.clientId },
            { label: 'Client Secret', value: revealedSecret.clientSecret, secret: true },
          ]}
          onClose={() => setRevealedSecret(null)}
        />
      ) : null}

      <DashboardSkeletonSwap
        isLoading={isLoading}
        skeleton={
          <>
            <DashboardActionRowSkeleton count={1} widths={[112]} />
            <DashboardListSkeleton rows={2} />
          </>
        }
        contentClassName="skeleton-content"
      >
        <div id="oauth-apps-list">
          {apps.map((app) => (
            <div key={app._id} className="oauth-app-card" style={glassCardStyle}>
              <div className="flex items-start justify-between gap-3">
                <div style={{ minWidth: 0 }}>
                  <div className="font-bold text-base text-white">{app.name}</div>
                  <div
                    style={{
                      fontFamily: "'DM Mono',monospace",
                      fontSize: '12px',
                      color: 'rgba(255,255,255,0.55)',
                      marginTop: '4px',
                      wordBreak: 'break-all',
                    }}
                  >
                    {app.clientId}
                  </div>
                </div>
                <span className={`status-pill ${app.disabled ? 'disconnected' : 'connected'}`}>
                  {app.disabled ? 'Disabled' : 'Active'}
                </span>
              </div>

              <div style={{ marginTop: '14px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {app.scopes.map((scope) => (
                  <span key={scope} className="oauth-scope-pill">
                    {scope}
                  </span>
                ))}
              </div>

              <div style={{ marginTop: '14px' }}>
                <div
                  style={{
                    fontSize: '12px',
                    color: 'rgba(255,255,255,0.55)',
                    fontWeight: 700,
                    marginBottom: '8px',
                  }}
                >
                  Redirect URIs
                </div>
                <div style={{ display: 'grid', gap: '6px' }}>
                  {app.redirectUris.map((uri) => (
                    <div
                      key={uri}
                      style={{
                        fontFamily: "'DM Mono',monospace",
                        fontSize: '11px',
                        color: 'rgba(255,255,255,0.72)',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: '10px',
                        padding: '8px 10px',
                        wordBreak: 'break-all',
                      }}
                    >
                      {uri}
                    </div>
                  ))}
                </div>
              </div>

              <div className="inline-btn-row" style={{ marginTop: '16px' }}>
                <button className="btn-ghost" type="button" onClick={() => openEditPanel(app)}>
                  Edit
                </button>
                <button
                  className="btn-ghost"
                  type="button"
                  disabled={
                    regenerateMutation.isPending && regenerateMutation.variables?._id === app._id
                  }
                  onClick={() => regenerateMutation.mutate(app)}
                >
                  {regenerateMutation.isPending && regenerateMutation.variables?._id === app._id
                    ? 'Regenerating…'
                    : 'Regenerate Secret'}
                </button>
                <button
                  className="btn-ghost"
                  type="button"
                  style={{ color: '#f87171' }}
                  disabled={deleteMutation.isPending && deleteMutation.variables === app._id}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Delete OAuth app "${app.name}"? Existing integrations will stop working.`
                      )
                    ) {
                      return;
                    }
                    deleteMutation.mutate(app._id);
                  }}
                >
                  Delete
                </button>
              </div>

              {editingAppId === app._id ? (
                <div className="oauth-edit-body">
                  <InlineOAuthAppFields
                    name={editingName}
                    redirectUris={editingRedirectUris}
                    selectedScopes={editingScopes}
                    onNameChange={setEditingName}
                    onRedirectUrisChange={setEditingRedirectUris}
                    onScopeToggle={(scope) =>
                      setEditingScopes((current) => toggleScope(current, scope))
                    }
                  />
                  <div className="inline-btn-row">
                    <button
                      className="btn-primary"
                      type="button"
                      disabled={updateMutation.isPending}
                      onClick={() => updateMutation.mutate(app._id)}
                    >
                      {updateMutation.isPending ? 'Saving…' : 'Save changes'}
                    </button>
                    <button
                      className="btn-ghost"
                      type="button"
                      onClick={() => setEditingAppId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {apps.length === 0 ? (
          <div id="oauth-apps-empty" className="empty-state developer-intg-empty">
            <div className="intg-icon" style={{ margin: '0 auto 14px' }}>
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <p className="empty-state-title">No OAuth apps yet</p>
            <p className="empty-state-copy">
              Use OAuth when a third-party app needs to access verification data on behalf of your
              users.
            </p>
            <button className="intg-add-btn" type="button" onClick={() => setCreatePanelOpen(true)}>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add your first app
            </button>
          </div>
        ) : null}
      </DashboardSkeletonSwap>
    </section>
  );
}

function ApiKeysSection({
  authUserId,
  viewerLoading,
}: {
  authUserId: string | undefined;
  viewerLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const { canRunPanelQueries, markSessionExpired } = useDashboardSession();
  const [createPanelOpen, setCreatePanelOpen] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['verification:read', 'subjects:read']);
  const [revealedKey, setRevealedKey] = useState<CreatedPublicApiKey | null>(null);

  const apiKeysQuery = useQuery(
    dashboardPanelQueryOptions<PublicApiKeySummary[]>({
      queryKey: ['dashboard-api-keys', authUserId],
      queryFn: () => listPublicApiKeys(requireAuthUserId(authUserId)),
      enabled: canRunPanelQueries && Boolean(authUserId),
    })
  );

  useEffect(() => {
    if (isDashboardAuthError(apiKeysQuery.error)) {
      markSessionExpired();
    }
  }, [apiKeysQuery.error, markSessionExpired]);

  const hasAuthError = isDashboardAuthError(apiKeysQuery.error);

  const createMutation = useMutation({
    mutationFn: () =>
      createPublicApiKey(requireAuthUserId(authUserId), {
        name: keyName.trim(),
        scopes,
      }),
    onSuccess: async (created) => {
      setRevealedKey(created);
      setKeyName('');
      setScopes(['verification:read', 'subjects:read']);
      setCreatePanelOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['dashboard-api-keys', authUserId] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => revokePublicApiKey(requireAuthUserId(authUserId), keyId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['dashboard-api-keys', authUserId] });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: (key: PublicApiKeySummary) =>
      rotatePublicApiKey(requireAuthUserId(authUserId), key._id),
    onSuccess: async (created) => {
      setRevealedKey(created);
      await queryClient.invalidateQueries({ queryKey: ['dashboard-api-keys', authUserId] });
    },
  });

  if (hasAuthError) {
    return (
      <DashboardAuthRequiredState
        id="dashboard-api-keys-auth-required"
        title="Sign in to manage API keys"
        description="Your dashboard session expired while loading API keys. Sign in again to keep managing developer integrations."
      />
    );
  }

  const isLoading = viewerLoading || (canRunPanelQueries && apiKeysQuery.isLoading);
  const keys = apiKeysQuery.data ?? [];

  return (
    <section className="intg-card bento-col-6 animate-in animate-in-delay-5" id="api-keys-section">
      <div className="intg-header">
        <div className="intg-title-row">
          {!isLoading ? (
            <div className="intg-icon">
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
              </svg>
            </div>
          ) : null}
          <div className="intg-copy developer-intg-copy">
            <h2 className="intg-title">API Keys</h2>
            <p className="intg-desc">
              Call the verification API from your integrations. Pass as <code>x-api-key</code>{' '}
              header.
            </p>
          </div>
        </div>
        <button
          id="create-api-key-btn"
          className="intg-add-btn"
          type="button"
          onClick={() => setCreatePanelOpen(true)}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add key
        </button>
      </div>

      <InlineApiKeyForm
        open={createPanelOpen}
        name={keyName}
        scopes={scopes}
        submitLabel={createMutation.isPending ? 'Creating…' : 'Create key'}
        onClose={() => setCreatePanelOpen(false)}
        onNameChange={setKeyName}
        onScopeToggle={(scope) => setScopes((current) => toggleScope(current, scope))}
        onSubmit={() => createMutation.mutate()}
      />

      {revealedKey ? (
        <CredentialRevealCard
          id="api-key-reveal"
          title={revealedKey.name}
          subtitle="Copy this API key now. It will not be shown again."
          fields={[
            { label: 'Key Prefix', value: revealedKey.prefix },
            { label: 'API Key', value: revealedKey.apiKey, secret: true },
          ]}
          onClose={() => setRevealedKey(null)}
        />
      ) : null}

      <DashboardSkeletonSwap
        isLoading={isLoading}
        skeleton={
          <>
            <DashboardActionRowSkeleton count={1} widths={[112]} />
            <DashboardListSkeleton rows={2} />
          </>
        }
        contentClassName="skeleton-content"
      >
        <div id="api-keys-list" style={{ display: 'grid', gap: '12px' }}>
          {keys.map((key) => (
            <div key={key._id} className="api-key-row" style={glassRowStyle}>
              <div className="api-key-info">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="font-bold text-base text-white">{key.name}</div>
                  <span
                    className={`status-pill ${key.status === 'active' ? 'connected' : 'disconnected'}`}
                  >
                    {key.status}
                  </span>
                </div>
                <div
                  style={{
                    fontFamily: "'DM Mono',monospace",
                    fontSize: '12px',
                    color: 'rgba(255,255,255,0.58)',
                    marginTop: '4px',
                  }}
                >
                  {key.prefix}••••••••••••
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' }}>
                  {key.scopes.map((scope) => (
                    <span key={scope} className="api-key-scope-badge">
                      {scope}
                    </span>
                  ))}
                </div>
                <div
                  style={{
                    marginTop: '10px',
                    fontSize: '12px',
                    color: 'rgba(255,255,255,0.55)',
                    fontFamily: "'AirbnbCereal',sans-serif",
                  }}
                >
                  {key.lastUsedAt ? `Last used ${formatDateTime(key.lastUsedAt)}` : 'Never used'}
                </div>
              </div>
              <div className="inline-btn-row" style={{ marginLeft: 'auto' }}>
                <button
                  className="btn-ghost"
                  type="button"
                  disabled={
                    key.status !== 'active' ||
                    (rotateMutation.isPending && rotateMutation.variables?._id === key._id)
                  }
                  onClick={() => rotateMutation.mutate(key)}
                >
                  {rotateMutation.isPending && rotateMutation.variables?._id === key._id
                    ? 'Rotating…'
                    : 'Rotate'}
                </button>
                <button
                  className="btn-ghost"
                  type="button"
                  style={{ color: '#f87171' }}
                  disabled={
                    key.status !== 'active' ||
                    (revokeMutation.isPending && revokeMutation.variables === key._id)
                  }
                  onClick={() => {
                    if (!window.confirm(`Revoke API key "${key.name}"? This cannot be undone.`)) {
                      return;
                    }
                    revokeMutation.mutate(key._id);
                  }}
                >
                  {revokeMutation.isPending && revokeMutation.variables === key._id
                    ? 'Revoking…'
                    : 'Revoke'}
                </button>
              </div>
            </div>
          ))}
        </div>

        {keys.length === 0 ? (
          <div id="api-keys-empty" className="empty-state developer-intg-empty">
            <div className="intg-icon" style={{ margin: '0 auto 14px' }}>
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
              </svg>
            </div>
            <p className="empty-state-title">No API keys yet</p>
            <p className="empty-state-copy">
              API keys let you call the verification API from scripts, bots, or integrations. Pass
              the key in the <code>x-api-key</code> header.
            </p>
            <button className="intg-add-btn" type="button" onClick={() => setCreatePanelOpen(true)}>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add your first key
            </button>
          </div>
        ) : null}
      </DashboardSkeletonSwap>
    </section>
  );
}

function InlineOAuthAppForm({
  open,
  title,
  submitLabel,
  name,
  redirectUris,
  selectedScopes,
  onClose,
  onNameChange,
  onRedirectUrisChange,
  onScopeToggle,
  onSubmit,
}: {
  open: boolean;
  title: string;
  submitLabel: string;
  name: string;
  redirectUris: string;
  selectedScopes: string[];
  onClose: () => void;
  onNameChange: (value: string) => void;
  onRedirectUrisChange: (value: string) => void;
  onScopeToggle: (scope: string) => void;
  onSubmit: () => void;
}) {
  return (
    <DashboardBodyPortal>
      <div className={`inline-panel${open ? ' open' : ''}`} id="create-oauth-app-panel">
        <button
          type="button"
          aria-label="Close OAuth app panel"
          onClick={onClose}
          style={{
            position: 'absolute',
            inset: 0,
            border: 'none',
            background: 'transparent',
            padding: 0,
          }}
        />
        <div className="inline-panel-inner" style={{ position: 'relative', zIndex: 1 }}>
          <div className="inline-panel-body">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '16px',
              }}
            >
              <p className="inline-panel-title" style={{ margin: 0 }}>
                {title}
              </p>
              <button type="button" onClick={onClose} className="panel-close-btn">
                &times;
              </button>
            </div>
            <InlineOAuthAppFields
              name={name}
              redirectUris={redirectUris}
              selectedScopes={selectedScopes}
              onNameChange={onNameChange}
              onRedirectUrisChange={onRedirectUrisChange}
              onScopeToggle={onScopeToggle}
            />
            <div className="inline-btn-row">
              <button
                className="btn-primary"
                type="button"
                id="create-oauth-app-submit"
                onClick={onSubmit}
              >
                {submitLabel}
              </button>
              <button className="btn-ghost" type="button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </DashboardBodyPortal>
  );
}

function InlineOAuthAppFields({
  name,
  redirectUris,
  selectedScopes,
  onNameChange,
  onRedirectUrisChange,
  onScopeToggle,
}: {
  name: string;
  redirectUris: string;
  selectedScopes: string[];
  onNameChange: (value: string) => void;
  onRedirectUrisChange: (value: string) => void;
  onScopeToggle: (scope: string) => void;
}) {
  return (
    <>
      <div className="modal-field">
        <label className="modal-label" htmlFor="oauth-app-name">
          App name
        </label>
        <input
          type="text"
          id="oauth-app-name"
          className="modal-input"
          placeholder="e.g. My Verification Bot"
          maxLength={64}
          autoComplete="off"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </div>
      <div className="modal-field">
        <label className="modal-label" htmlFor="oauth-app-redirect-uris">
          Redirect URIs
        </label>
        <span className="modal-helper">
          One URI per line. Example: https://yourapp.com/callback
        </span>
        <textarea
          id="oauth-app-redirect-uris"
          rows={3}
          className="modal-textarea"
          placeholder="https://yourapp.com/callback"
          value={redirectUris}
          onChange={(event) => onRedirectUrisChange(event.target.value)}
        />
      </div>
      <div className="modal-field" style={{ marginBottom: 0 }}>
        <div className="modal-label">Scopes</div>
        <div className="scope-toggles">
          {OAUTH_SCOPE_OPTIONS.map((scope) => (
            <label key={scope.key} className="scope-toggle">
              <input
                type="checkbox"
                checked={selectedScopes.includes(scope.key)}
                onChange={() => onScopeToggle(scope.key)}
              />
              <div className="scope-toggle-card">
                <div className="scope-toggle-check">
                  <svg aria-hidden="true" viewBox="0 0 12 12">
                    <polyline points="2 6 5 9 10 3" />
                  </svg>
                </div>
                <div className="scope-toggle-text">
                  <div className="scope-toggle-name">{scope.name}</div>
                  <div className="scope-toggle-desc">{scope.description}</div>
                </div>
              </div>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

function InlineApiKeyForm({
  open,
  name,
  scopes,
  submitLabel,
  onClose,
  onNameChange,
  onScopeToggle,
  onSubmit,
}: {
  open: boolean;
  name: string;
  scopes: string[];
  submitLabel: string;
  onClose: () => void;
  onNameChange: (value: string) => void;
  onScopeToggle: (scope: string) => void;
  onSubmit: () => void;
}) {
  return (
    <DashboardBodyPortal>
      <div className={`inline-panel${open ? ' open' : ''}`} id="create-api-key-panel">
        <button
          type="button"
          aria-label="Close API key panel"
          onClick={onClose}
          style={{
            position: 'absolute',
            inset: 0,
            border: 'none',
            background: 'transparent',
            padding: 0,
          }}
        />
        <div className="inline-panel-inner" style={{ position: 'relative', zIndex: 1 }}>
          <div className="inline-panel-body">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '16px',
              }}
            >
              <p className="inline-panel-title" style={{ margin: 0 }}>
                New API key
              </p>
              <button type="button" onClick={onClose} className="panel-close-btn">
                &times;
              </button>
            </div>
            <div className="modal-field">
              <label className="modal-label" htmlFor="api-key-name">
                Key name
              </label>
              <span className="modal-helper">e.g. Production bot, Staging integration</span>
              <input
                type="text"
                id="api-key-name"
                className="modal-input"
                placeholder="e.g. Production bot"
                maxLength={64}
                autoComplete="off"
                value={name}
                onChange={(event) => onNameChange(event.target.value)}
              />
            </div>
            <div className="modal-field" style={{ marginBottom: 0 }}>
              <div className="modal-label">Permissions</div>
              <div className="scope-toggles">
                {OAUTH_SCOPE_OPTIONS.map((scope) => (
                  <label key={scope.key} className="scope-toggle">
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope.key)}
                      onChange={() => onScopeToggle(scope.key)}
                    />
                    <div className="scope-toggle-card">
                      <div className="scope-toggle-check">
                        <svg aria-hidden="true" viewBox="0 0 12 12">
                          <polyline points="2 6 5 9 10 3" />
                        </svg>
                      </div>
                      <div className="scope-toggle-text">
                        <div className="scope-toggle-name">{scope.name}</div>
                        <div className="scope-toggle-desc">{scope.description}</div>
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
            <div className="inline-btn-row">
              <button
                className="btn-primary"
                type="button"
                id="create-api-key-submit"
                onClick={onSubmit}
              >
                {submitLabel}
              </button>
              <button className="btn-ghost" type="button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </DashboardBodyPortal>
  );
}

function CredentialRevealCard({
  id,
  title,
  subtitle,
  fields,
  onClose,
}: {
  id: string;
  title: string;
  subtitle: string;
  fields: Array<{ label: string; value: string; secret?: boolean }>;
  onClose: () => void;
}) {
  return (
    <div
      id={id}
      style={{
        marginBottom: '16px',
        padding: '16px',
        borderRadius: '14px',
        border: '1px solid rgba(14,165,233,0.25)',
        background: 'rgba(14,165,233,0.08)',
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-bold text-white">{title}</div>
          <p
            style={{
              margin: '6px 0 0',
              fontSize: '12px',
              color: 'rgba(255,255,255,0.7)',
              fontFamily: "'AirbnbCereal',sans-serif",
            }}
          >
            {subtitle}
          </p>
        </div>
        <button type="button" className="btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <div style={{ display: 'grid', gap: '10px', marginTop: '14px' }}>
        {fields.map((field) => (
          <div key={field.label}>
            <div
              style={{
                fontSize: '11px',
                fontWeight: 800,
                color: 'rgba(255,255,255,0.55)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: '6px',
              }}
            >
              {field.label}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '10px',
                padding: '10px 12px',
              }}
            >
              <div
                style={{
                  flex: 1,
                  fontFamily: "'DM Mono',monospace",
                  fontSize: '12px',
                  color: '#fff',
                  wordBreak: 'break-all',
                }}
              >
                {field.value}
              </div>
              <button
                type="button"
                className="cred-copy"
                aria-label={`Copy ${field.label}`}
                onClick={() => void copyToClipboard(field.value)}
              >
                Copy
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function parseMultilineValues(input: string) {
  return input
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
}

function toggleScope(current: string[], scope: string) {
  if (current.includes(scope)) {
    return current.filter((item) => item !== scope);
  }
  return [...current, scope];
}

function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function requireAuthUserId(authUserId: string | undefined) {
  if (!authUserId) {
    throw new Error('Not authenticated');
  }

  return authUserId;
}

const glassCardStyle = {
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '16px',
  background: 'rgba(15, 23, 42, 0.4)',
  padding: '16px',
  marginBottom: '12px',
} satisfies React.CSSProperties;

const glassRowStyle = {
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '14px',
  background: 'rgba(15, 23, 42, 0.4)',
  padding: '14px 16px',
  display: 'flex',
  alignItems: 'center',
  gap: '14px',
} satisfies React.CSSProperties;
