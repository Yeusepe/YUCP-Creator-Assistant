import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { useServerContext } from '@/hooks/useServerContext';

export const Route = createFileRoute('/dashboard/')({
  component: DashboardIndex,
});

/* ------------------------------------------------------------------ */
/*  Reusable save indicator (matches original HTML exactly)            */
/* ------------------------------------------------------------------ */

function SaveIndicator({ settingKey }: { settingKey: string }) {
  return (
    <>
      <span className="save-indicator tile-save-indicator" data-for={settingKey} aria-live="polite">
        <svg
          className="save-indicator-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <polyline points="17 21 17 13 7 13 7 21" />
          <polyline points="7 3 7 8 15 8" />
        </svg>
      </span>
      <span
        className="save-indicator save-indicator-error tile-save-error"
        data-for={settingKey}
        aria-live="assertive"
        hidden
      >
        <svg
          className="save-indicator-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      </span>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

function DashboardIndex() {
  const { isPersonalDashboard: _isPersonalDashboard } = useServerContext();

  return (
    <div
      id="tab-panel-setup"
      className="dashboard-tab-panel is-active"
      role="tabpanel"
      aria-labelledby="tab-btn-setup"
    >
      <div className="bento-grid">
        {/* Personal mode sections */}
        <PersonalSetupPanel />
        <ConnectedPlatformsPanel />

        {/* Server mode sections */}
        <ServerConfigPanel />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Personal: Participating Servers                                    */
/* ------------------------------------------------------------------ */

function PersonalSetupPanel() {
  return (
    <section
      id="collab-servers-section"
      className="section-card bento-col-12 p-4 sm:p-5 md:p-7 animate-in animate-in-delay-1 personal-only"
      style={{ marginBottom: '24px' }}
    >
      <div className="flex items-center gap-3 mb-6">
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center"
          style={{ background: 'rgba(14, 165, 233, 0.15)' }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent-sky)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </div>
        <h2 className="text-lg font-black" style={{ margin: 0 }}>
          Participating Servers
        </h2>
      </div>
      <p className="text-sm text-white/70 mb-4" style={{ fontFamily: "'DM Sans', sans-serif" }}>
        These are the servers you collaborate on. Use the dropdown in the sidebar to configure
        specific server settings.
      </p>
      {/* Skeleton placeholder */}
      <div
        className="skeleton-group"
        aria-hidden="true"
        style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}
      >
        <div className="skeleton-block skeleton-card" />
        <div className="skeleton-block skeleton-card" />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Personal: Connected Platforms                                      */
/* ------------------------------------------------------------------ */

function ConnectedPlatformsPanel() {
  return (
    <section
      id="connected-platforms-section"
      className="section-card bento-col-12 p-4 sm:p-5 md:p-7 animate-in animate-in-delay-2 personal-only"
    >
      <div className="flex items-center gap-3 mb-6">
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center"
          style={{ background: 'rgba(255,235,59,0.15)' }}
        >
          <img src="/Icons/Link.png" className="w-4 h-4 object-contain" alt="" />
        </div>
        <h2 className="text-lg font-black">Connected Platforms</h2>
      </div>

      {/* Dynamic user accounts list */}
      <div
        id="user-accounts-list"
        className="grid grid-cols-1 md:grid-cols-3 gap-4"
        style={{ marginBottom: '16px' }}
      />

      {/* Skeleton placeholder */}
      <div className="skeleton-group" aria-hidden="true">
        <div className="skeleton-block skeleton-card" />
        <div className="skeleton-block skeleton-card" />
        <div className="skeleton-block skeleton-card" />
      </div>

      {/* Add account buttons */}
      <div
        id="add-account-buttons"
        style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '24px' }}
      />

      <div
        className="grid grid-cols-1 md:grid-cols-3 gap-4"
        id="platforms-grid"
        style={{ display: 'none' }}
      >
        {/* Discord (always connected) */}
        <div className="platform-card connected">
          <div className="flex items-start justify-between">
            <div className="w-10 h-10 bg-[#5865F2] rounded-xl flex items-center justify-center overflow-hidden">
              <img src="/Icons/Discord.png" className="w-6 h-6 object-contain" alt="Discord®" />
            </div>
            <span className="status-pill connected">Connected</span>
          </div>
          <div>
            <h3 className="font-bold text-base mb-0.5">Discord&reg;</h3>
            <p className="text-xs text-white/60" style={{ fontFamily: "'DM Sans',sans-serif" }}>
              Bot access active
            </p>
          </div>
        </div>

        <div id="dynamic-platform-cards" className="contents" />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Server: Config Panel                                               */
/* ------------------------------------------------------------------ */

function ServerConfigPanel() {
  const { guildId: _guildId } = useServerContext();

  const [settings, setSettings] = useState({
    allowMismatchedEmails: false,
    autoVerifyOnJoin: false,
    shareVerificationWithServers: false,
    enableDiscordRoleFromOtherServers: false,
  });

  const toggleSetting = useCallback((key: keyof typeof settings) => {
    setSettings((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  return (
    <div
      id="server-settings-card"
      className="svr-cfg bento-col-12 animate-in animate-in-delay-3 server-only"
    >
      <div className="svr-cfg-bar">
        <h2 className="svr-cfg-title">Server Config</h2>
      </div>

      {/* Store Integrations */}
      <div className="settings-subsection" id="server-store-integrations-section">
        <div className="settings-subsection-title">Store Integrations</div>
        <div className="settings-subsection-body">
          <div id="dynamic-server-provider-tiles" />
          {/* Skeleton placeholder */}
          <div className="skeleton-group" aria-hidden="true">
            <div className="skeleton-block skeleton-card" />
            <div className="skeleton-block skeleton-card" />
          </div>
          <div
            id="server-integrations-empty"
            className="p-4 bg-white/5 border border-white/10 rounded-xl text-center text-sm text-[rgba(255,255,255,0.6)]"
          >
            No store accounts linked. Add a store account in the{' '}
            <strong>Connected Platforms</strong> section above.
          </div>
        </div>
      </div>

      {/* General Settings */}
      <div className="settings-subsection">
        <div className="settings-subsection-title">General</div>
        <div className="settings-subsection-body">
          {/* Allow Mismatched Emails */}
          <article className="svr-cfg-tile">
            <div className="svr-cfg-tile-head">
              <div className="svr-cfg-tile-icon">
                <img src="/Icons/World.png" alt="" />
              </div>
              <div className="svr-cfg-tile-text">
                <span className="svr-cfg-tile-label">Allow Mismatched Emails</span>
                <span className="svr-cfg-tile-hint">
                  Verify with a different email than Discord.
                </span>
              </div>
            </div>
            <div className="svr-cfg-tile-ctrl">
              <div
                id="toggle-allowMismatchedEmails"
                className={`svr-cfg-switch${settings.allowMismatchedEmails ? ' is-on' : ''}`}
                role="switch"
                aria-checked={settings.allowMismatchedEmails}
                onClick={() => toggleSetting('allowMismatchedEmails')}
                aria-label="Allow Mismatched Emails"
              />
              <SaveIndicator settingKey="allowMismatchedEmails" />
            </div>
          </article>

          {/* Auto-Verify on Join */}
          <article className="svr-cfg-tile">
            <div className="svr-cfg-tile-head">
              <div className="svr-cfg-tile-icon">
                <img src="/Icons/Refresh.png" alt="" />
              </div>
              <div className="svr-cfg-tile-text">
                <span className="svr-cfg-tile-label">Auto-Verify on Join</span>
                <span className="svr-cfg-tile-hint">
                  Automatically verify members when they join the server.
                </span>
              </div>
            </div>
            <div className="svr-cfg-tile-ctrl">
              <div
                id="toggle-autoVerifyOnJoin"
                className={`svr-cfg-switch${settings.autoVerifyOnJoin ? ' is-on' : ''}`}
                role="switch"
                aria-checked={settings.autoVerifyOnJoin}
                onClick={() => toggleSetting('autoVerifyOnJoin')}
                aria-label="Auto-Verify on Join"
              />
              <SaveIndicator settingKey="autoVerifyOnJoin" />
            </div>
          </article>

          {/* Share Across Servers */}
          <article className="svr-cfg-tile">
            <div className="svr-cfg-tile-head">
              <div className="svr-cfg-tile-icon">
                <img src="/Icons/Link.png" alt="" />
              </div>
              <div className="svr-cfg-tile-text">
                <span className="svr-cfg-tile-label">Share Across Servers</span>
                <span className="svr-cfg-tile-hint">
                  Same Discord account, different servers -- verification carries over.
                </span>
              </div>
            </div>
            <div className="svr-cfg-tile-ctrl">
              <div
                id="toggle-shareVerificationWithServers"
                className={`svr-cfg-switch${settings.shareVerificationWithServers ? ' is-on' : ''}`}
                role="switch"
                aria-checked={settings.shareVerificationWithServers}
                onClick={() => toggleSetting('shareVerificationWithServers')}
                aria-label="Share Across Servers"
              />
              <SaveIndicator settingKey="shareVerificationWithServers" />
            </div>
          </article>

          {/* Cross-Server Role Checks */}
          <article className="svr-cfg-tile">
            <div className="svr-cfg-tile-head">
              <div className="svr-cfg-tile-icon">
                <img src="/Icons/PersonKey.png" alt="" />
              </div>
              <div className="svr-cfg-tile-text">
                <span className="svr-cfg-tile-label">Cross-Server Role Checks</span>
                <span className="svr-cfg-tile-hint">Check roles from servers the user is in.</span>
              </div>
            </div>
            <div className="svr-cfg-tile-ctrl">
              <div
                id="toggle-enableDiscordRoleFromOtherServers"
                className={`svr-cfg-switch${settings.enableDiscordRoleFromOtherServers ? ' is-on' : ''}`}
                role="switch"
                aria-checked={settings.enableDiscordRoleFromOtherServers}
                onClick={() => toggleSetting('enableDiscordRoleFromOtherServers')}
                aria-label="Cross-Server Role Checks"
              />
              <SaveIndicator settingKey="enableDiscordRoleFromOtherServers" />
            </div>
          </article>

          {/* Verification Scope */}
          <article className="svr-cfg-tile">
            <div className="svr-cfg-tile-head">
              <div className="svr-cfg-tile-icon">
                <img src="/Icons/Key.png" alt="" />
              </div>
              <div className="svr-cfg-tile-text">
                <span className="svr-cfg-tile-label">Verification Scope</span>
                <span className="svr-cfg-tile-hint">How verifications are scoped for buyers.</span>
              </div>
            </div>
            <div className="svr-cfg-tile-ctrl">
              <select id="select-verificationScope" className="svr-cfg-pick" defaultValue="account">
                <option value="account">Account</option>
                <option value="license">License</option>
              </select>
              <SaveIndicator settingKey="verificationScope" />
            </div>
          </article>

          {/* Duplicate Verifications */}
          <article className="svr-cfg-tile">
            <div className="svr-cfg-tile-head">
              <div className="svr-cfg-tile-icon">
                <img src="/Icons/ClapStars.png" alt="" />
              </div>
              <div className="svr-cfg-tile-text">
                <span className="svr-cfg-tile-label">Duplicate Verifications</span>
                <span className="svr-cfg-tile-hint">What happens when a user verifies twice.</span>
              </div>
            </div>
            <div className="svr-cfg-tile-ctrl">
              <select
                id="select-duplicateVerificationBehavior"
                className="svr-cfg-pick"
                defaultValue="allow"
              >
                <option value="allow">Allow</option>
                <option value="notify">Notify</option>
                <option value="block">Block</option>
              </select>
              <SaveIndicator settingKey="duplicateVerificationBehavior" />
            </div>
          </article>

          {/* Suspicious Accounts */}
          <article className="svr-cfg-tile">
            <div className="svr-cfg-tile-head">
              <div className="svr-cfg-tile-icon">
                <img src="/Icons/X.png" alt="" />
              </div>
              <div className="svr-cfg-tile-text">
                <span className="svr-cfg-tile-label">Suspicious Accounts</span>
                <span className="svr-cfg-tile-hint">
                  How to handle potentially fraudulent accounts.
                </span>
              </div>
            </div>
            <div className="svr-cfg-tile-ctrl">
              <select
                id="select-suspiciousAccountBehavior"
                className="svr-cfg-pick"
                defaultValue="notify"
              >
                <option value="notify">Notify</option>
                <option value="quarantine">Quarantine</option>
                <option value="revoke">Revoke</option>
              </select>
              <SaveIndicator settingKey="suspiciousAccountBehavior" />
            </div>
          </article>

          {/* Logs Channel */}
          <article className="svr-cfg-tile">
            <div className="svr-cfg-tile-head">
              <div className="svr-cfg-tile-icon">
                <img src="/Icons/Library.png" alt="" />
              </div>
              <div className="svr-cfg-tile-text">
                <span className="svr-cfg-tile-label">Logs Channel</span>
                <span className="svr-cfg-tile-hint">
                  Channel where verification activity logs are posted.
                </span>
              </div>
            </div>
            <div className="svr-cfg-tile-ctrl">
              <select id="select-logChannelId" className="svr-cfg-pick">
                <option value="">-- select a channel --</option>
              </select>
              <SaveIndicator settingKey="logChannelId" />
            </div>
          </article>

          {/* Announcements Channel */}
          <article className="svr-cfg-tile">
            <div className="svr-cfg-tile-head">
              <div className="svr-cfg-tile-icon">
                <img src="/Icons/World.png" alt="" />
              </div>
              <div className="svr-cfg-tile-text">
                <span className="svr-cfg-tile-label">Announcements Channel</span>
                <span className="svr-cfg-tile-hint">
                  Channel where bot updates and announcements are posted.
                </span>
              </div>
            </div>
            <div className="svr-cfg-tile-ctrl">
              <select id="select-announcementsChannelId" className="svr-cfg-pick">
                <option value="">-- select a channel --</option>
              </select>
              <SaveIndicator settingKey="announcementsChannelId" />
            </div>
          </article>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="settings-subsection" style={{ marginTop: '16px' }}>
        <div className="settings-subsection-title" style={{ color: '#ef4444' }}>
          Danger Zone
        </div>
        <div className="settings-subsection-body">
          <article className="svr-cfg-tile" style={{ border: '1px solid rgba(239,68,68,0.15)' }}>
            <div className="svr-cfg-tile-head">
              <div
                className="svr-cfg-tile-icon"
                style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </div>
              <div className="svr-cfg-tile-text">
                <span className="svr-cfg-tile-label">Disconnect Server</span>
                <span className="svr-cfg-tile-hint">
                  Permanently remove this server and delete all verification data.
                </span>
              </div>
            </div>
            <div className="svr-cfg-tile-ctrl">
              <button
                id="server-disconnect-btn"
                type="button"
                className="card-action-btn disconnect"
                style={{
                  background: 'rgba(239,68,68,0.1)',
                  border: '1px solid rgba(239,68,68,0.3)',
                  color: '#ef4444',
                  padding: '8px 16px',
                  borderRadius: '10px',
                  fontSize: '13px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                  transition: 'all 0.2s',
                  whiteSpace: 'nowrap',
                }}
              >
                Disconnect
              </button>
            </div>
          </article>
          {/* 3-step disconnect confirmation area */}
          <div id="server-disconnect-steps" style={{ display: 'none' }} />
        </div>
      </div>
    </div>
  );
}
