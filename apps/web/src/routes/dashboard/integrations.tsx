import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useState } from 'react';

export const Route = createFileRoute('/dashboard/integrations')({
  component: DashboardIntegrations,
});

function DashboardIntegrations() {
  return (
    <div
      id="tab-panel-integrations"
      className="dashboard-tab-panel is-active"
      role="tabpanel"
      aria-labelledby="tab-btn-integrations"
    >
      <div className="bento-grid integrations-grid">
        <OAuthAppsSection />
        <ApiKeysSection />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  OAuth Apps Section                                                 */
/* ------------------------------------------------------------------ */

function OAuthAppsSection() {
  const [createPanelOpen, setCreatePanelOpen] = useState(false);
  const [appName, setAppName] = useState('');
  const [redirectUris, setRedirectUris] = useState('');
  const [scopeVr, setScopeVr] = useState(true);
  const [scopeSr, setScopeSr] = useState(false);

  const openPanel = useCallback(() => setCreatePanelOpen(true), []);
  const closePanel = useCallback(() => setCreatePanelOpen(false), []);

  return (
    <section
      className="intg-card bento-col-6 animate-in animate-in-delay-5"
      id="oauth-apps-section"
    >
      <div className="intg-header">
        <div className="intg-title-row">
          <div className="intg-icon">
            <svg
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
          <h2 className="intg-title">OAuth Applications</h2>
        </div>
        <button id="create-oauth-app-btn" className="intg-add-btn" onClick={openPanel}>
          <svg
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
      <p className="intg-desc">
        Register apps that use the OAuth 2.0 flow to access user verification data on their behalf.
      </p>

      {/* Inline create OAuth app form */}
      <div
        className={`inline-panel${createPanelOpen ? ' open' : ''}`}
        id="create-oauth-app-panel"
        onClick={(e) => {
          if (
            e.target === e.currentTarget &&
            (e.currentTarget as HTMLElement).classList.contains('open')
          ) {
            closePanel();
          }
        }}
      >
        <div className="inline-panel-inner">
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
                Register OAuth app
              </p>
              <button onClick={closePanel} className="panel-close-btn">
                &times;
              </button>
            </div>
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
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
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
                onChange={(e) => setRedirectUris(e.target.value)}
              />
            </div>
            <div className="modal-field" style={{ marginBottom: 0 }}>
              <label className="modal-label">Scopes</label>
              <div className="scope-toggles">
                <label className="scope-toggle">
                  <input
                    type="checkbox"
                    id="create-oauth-scope-vr"
                    checked={scopeVr}
                    onChange={(e) => setScopeVr(e.target.checked)}
                  />
                  <div className="scope-toggle-card">
                    <div className="scope-toggle-check">
                      <svg viewBox="0 0 12 12">
                        <polyline points="2 6 5 9 10 3" />
                      </svg>
                    </div>
                    <div className="scope-toggle-text">
                      <div className="scope-toggle-name">verification:read</div>
                      <div className="scope-toggle-desc">
                        Check if a user is verified on your server
                      </div>
                    </div>
                  </div>
                </label>
                <label className="scope-toggle">
                  <input
                    type="checkbox"
                    id="create-oauth-scope-sr"
                    checked={scopeSr}
                    onChange={(e) => setScopeSr(e.target.checked)}
                  />
                  <div className="scope-toggle-card">
                    <div className="scope-toggle-check">
                      <svg viewBox="0 0 12 12">
                        <polyline points="2 6 5 9 10 3" />
                      </svg>
                    </div>
                    <div className="scope-toggle-text">
                      <div className="scope-toggle-name">subjects:read</div>
                      <div className="scope-toggle-desc">
                        Read verified users and purchase records
                      </div>
                    </div>
                  </div>
                </label>
              </div>
            </div>
            <div className="inline-btn-row">
              <button className="btn-primary" id="create-oauth-app-submit">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                Register app
              </button>
              <button className="btn-ghost" onClick={closePanel}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>

      <div
        id="oauth-apps-signin-required"
        className="hidden text-center py-8 px-4 rounded-xl"
        style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}
      >
        <p
          className="text-sm font-medium"
          style={{ fontFamily: "'DM Sans',sans-serif", color: '#64748b' }}
        >
          Sign in to manage OAuth applications.
        </p>
      </div>

      {/* Apps list */}
      <div id="oauth-apps-list" />

      {/* Empty state */}
      <div id="oauth-apps-empty" className="empty-state hidden">
        <div className="intg-icon" style={{ margin: '0 auto 14px' }}>
          <svg
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
        <p className="text-sm font-semibold" style={{ fontFamily: "'DM Sans',sans-serif" }}>
          No OAuth apps yet
        </p>
        <p className="text-xs mt-2 max-w-xs mx-auto" style={{ fontFamily: "'DM Sans',sans-serif" }}>
          Use OAuth when a third-party app needs to access verification data on behalf of your
          users.
        </p>
        <button className="intg-add-btn" onClick={openPanel}>
          <svg
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

      {/* Loading state */}
      <div id="oauth-apps-loading" className="text-center py-8">
        <div
          className="inline-block w-5 h-5 border-2 rounded-full"
          style={{
            borderColor: '#e2e8f0',
            borderTopColor: '#0ea5e9',
            animation: 'page-loading-spin 0.8s linear infinite',
          }}
        />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  API Keys Section                                                   */
/* ------------------------------------------------------------------ */

function ApiKeysSection() {
  const [createPanelOpen, setCreatePanelOpen] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [scopeVerificationRead, setScopeVerificationRead] = useState(true);
  const [scopeSubjectsRead, setScopeSubjectsRead] = useState(true);

  const openPanel = useCallback(() => setCreatePanelOpen(true), []);
  const closePanel = useCallback(() => setCreatePanelOpen(false), []);

  return (
    <section className="intg-card bento-col-6 animate-in animate-in-delay-5" id="api-keys-section">
      <div className="intg-header">
        <div className="intg-title-row">
          <div className="intg-icon">
            <svg
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
          <h2 className="intg-title">API Keys</h2>
        </div>
        <button id="create-api-key-btn" className="intg-add-btn" onClick={openPanel}>
          <svg
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
      <p className="intg-desc">
        Call the verification API from your integrations. Pass as <code>x-api-key</code> header.
      </p>

      {/* Inline create API key form */}
      <div
        className={`inline-panel${createPanelOpen ? ' open' : ''}`}
        id="create-api-key-panel"
        onClick={(e) => {
          if (
            e.target === e.currentTarget &&
            (e.currentTarget as HTMLElement).classList.contains('open')
          ) {
            closePanel();
          }
        }}
      >
        <div className="inline-panel-inner">
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
              <button onClick={closePanel} className="panel-close-btn">
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
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
              />
            </div>
            <div className="modal-field" style={{ marginBottom: 0 }}>
              <label className="modal-label">Permissions</label>
              <div className="scope-toggles">
                <label className="scope-toggle">
                  <input
                    type="checkbox"
                    id="scope-verification-read"
                    checked={scopeVerificationRead}
                    onChange={(e) => setScopeVerificationRead(e.target.checked)}
                  />
                  <div className="scope-toggle-card">
                    <div className="scope-toggle-check">
                      <svg viewBox="0 0 12 12">
                        <polyline points="2 6 5 9 10 3" />
                      </svg>
                    </div>
                    <div className="scope-toggle-text">
                      <div className="scope-toggle-name">verification:read</div>
                      <div className="scope-toggle-desc">Check if a user is verified</div>
                    </div>
                  </div>
                </label>
                <label className="scope-toggle">
                  <input
                    type="checkbox"
                    id="scope-subjects-read"
                    checked={scopeSubjectsRead}
                    onChange={(e) => setScopeSubjectsRead(e.target.checked)}
                  />
                  <div className="scope-toggle-card">
                    <div className="scope-toggle-check">
                      <svg viewBox="0 0 12 12">
                        <polyline points="2 6 5 9 10 3" />
                      </svg>
                    </div>
                    <div className="scope-toggle-text">
                      <div className="scope-toggle-name">subjects:read</div>
                      <div className="scope-toggle-desc">
                        Read verified users and purchase records
                      </div>
                    </div>
                  </div>
                </label>
              </div>
            </div>
            <div className="inline-btn-row">
              <button className="btn-primary" id="create-api-key-submit">
                Create key
              </button>
              <button className="btn-ghost" onClick={closePanel}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>

      <div
        id="api-keys-signin-required"
        className="hidden text-center py-8 px-4 rounded-xl"
        style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}
      >
        <p
          className="text-sm font-medium"
          style={{ fontFamily: "'DM Sans',sans-serif", color: '#64748b' }}
        >
          Sign in to manage API keys.
        </p>
      </div>

      {/* API keys list */}
      <div id="api-keys-list" />

      {/* Empty state */}
      <div id="api-keys-empty" className="empty-state hidden">
        <div className="intg-icon" style={{ margin: '0 auto 14px' }}>
          <svg
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
        <p className="text-sm font-semibold" style={{ fontFamily: "'DM Sans',sans-serif" }}>
          No API keys yet
        </p>
        <p className="text-xs mt-2 max-w-xs mx-auto" style={{ fontFamily: "'DM Sans',sans-serif" }}>
          API keys let you call the verification API from scripts, bots, or integrations. Pass the
          key in the <code>x-api-key</code> header.
        </p>
        <button className="intg-add-btn" onClick={openPanel}>
          <svg
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

      {/* Loading state */}
      <div id="api-keys-loading" className="text-center py-8">
        <div
          className="inline-block w-5 h-5 border-2 rounded-full"
          style={{
            borderColor: '#e2e8f0',
            borderTopColor: '#0ea5e9',
            animation: 'page-loading-spin 0.8s linear infinite',
          }}
        />
      </div>
    </section>
  );
}
