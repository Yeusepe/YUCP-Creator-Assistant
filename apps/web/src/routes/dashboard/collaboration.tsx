import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { copyToClipboard } from '@/lib/utils';

export const Route = createFileRoute('/dashboard/collaboration')({
  component: DashboardCollaboration,
});

function DashboardCollaboration() {
  return (
    <div
      id="tab-panel-collaboration"
      className="dashboard-tab-panel is-active"
      role="tabpanel"
      aria-labelledby="tab-btn-collaboration"
    >
      <div className="bento-grid">
        <MyCollaboratorsSection />
        <StoresICollaborateWithSection />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  My Collaborators (left card)                                       */
/* ------------------------------------------------------------------ */

function MyCollaboratorsSection() {
  const [invitePanelOpen, setInvitePanelOpen] = useState(false);
  const [inviteStep, setInviteStep] = useState<'select' | 'url'>('select');
  const [inviteUrl, _setInviteUrl] = useState('');

  const openInvitePanel = useCallback(() => {
    setInvitePanelOpen(true);
    setInviteStep('select');
  }, []);

  const closeInvitePanel = useCallback(() => {
    setInvitePanelOpen(false);
  }, []);

  const handleCopyInviteUrl = useCallback(async () => {
    if (inviteUrl) {
      await copyToClipboard(inviteUrl);
    }
  }, [inviteUrl]);

  return (
    <section className="intg-card animate-in bento-col-7" id="collab-granted-card">
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
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <h2 className="intg-title">My Collaborators</h2>
        </div>
        <button id="invite-btn" className="intg-add-btn" onClick={openInvitePanel}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
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
      <p className="intg-desc">Allow members to verify licenses from other creators' stores.</p>

      {/* Invite panel */}
      <div
        className={`inline-panel${invitePanelOpen ? ' open' : ''}`}
        id="invite-panel"
        onClick={(e) => {
          if (
            e.target === e.currentTarget &&
            (e.currentTarget as HTMLElement).classList.contains('open')
          ) {
            closeInvitePanel();
          }
        }}
      >
        <div className="inline-panel-inner" style={{ maxWidth: '500px' }}>
          <div className="inline-panel-body" style={{ padding: '32px', textAlign: 'center' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                marginBottom: '-24px',
              }}
            >
              <button
                onClick={closeInvitePanel}
                className="panel-close-btn"
                aria-label="Close"
                style={{ zIndex: 10 }}
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
              Share this link with a trusted creator to allow them to link their stores and products
              to your server.
            </p>

            {/* Step 1: Provider selection */}
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
                <select id="invite-provider-select" className="invite-provider-pick" />
              </div>
              <button
                id="btn-generate-invite"
                style={{
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
                }}
              >
                Generate Invite Link
              </button>
            </div>

            {/* Step 2: URL display */}
            <div
              id="invite-step-url"
              style={{ display: inviteStep === 'url' ? undefined : 'none' }}
            >
              <div
                style={{
                  textAlign: 'left',
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '12px',
                  padding: '16px',
                  marginBottom: '20px',
                }}
              >
                <label
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
                  Unique Share Link
                </label>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <span
                    id="invite-url-display"
                    style={{
                      fontFamily: "'DM Mono',monospace",
                      fontSize: '14px',
                      color: '#fff',
                      wordBreak: 'break-all',
                      flex: 1,
                    }}
                  >
                    {inviteUrl}
                  </span>
                  <button
                    className="cred-copy"
                    id="copy-invite-btn"
                    onClick={handleCopyInviteUrl}
                    title="Copy link"
                    style={{
                      background: 'rgba(255,255,255,0.1)',
                      border: 'none',
                      width: '40px',
                      height: '40px',
                      borderRadius: '8px',
                      color: '#fff',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'background 0.2s',
                      flexShrink: 0,
                    }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      fill="none"
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
                  }}
                >
                  Expires in 7 days
                </div>
              </div>
              <div
                style={{
                  textAlign: 'left',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '12px',
                  padding: '16px',
                  marginBottom: '24px',
                }}
              >
                <label
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
                </label>
                <textarea
                  id="invite-message-template"
                  readOnly
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
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    marginTop: '8px',
                  }}
                >
                  <button
                    style={{
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
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    Copy template
                  </button>
                </div>
              </div>
              <button
                className="btn-primary"
                onClick={handleCopyInviteUrl}
                style={{
                  width: '100%',
                  justifyContent: 'center',
                  fontSize: '15px',
                  fontWeight: 700,
                  padding: '12px 24px',
                  background: '#0ea5e9',
                  color: '#fff',
                  borderRadius: '12px',
                  border: 'none',
                }}
              >
                Copy Invite Link
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Pending invites */}
      <div id="collab-invites-section" className="hidden" style={{ marginBottom: '24px' }}>
        <div className="collab-section-header">Pending Invites</div>
        <div id="collab-invites-list" />
      </div>

      <div id="collab-connections-header" className="collab-section-header hidden">
        Active Connections
      </div>
      <div id="collab-list" />

      {/* Empty state */}
      <div id="collab-empty" className="empty-state hidden">
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
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </div>
        <p className="text-sm font-semibold" style={{ fontFamily: "'DM Sans',sans-serif" }}>
          No collaborators yet.
        </p>
        <p className="text-xs mt-2 max-w-xs mx-auto" style={{ fontFamily: "'DM Sans',sans-serif" }}>
          Invite a creator to share license verification.
        </p>
        <button className="intg-add-btn" onClick={openInvitePanel} style={{ marginTop: '16px' }}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
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

      {/* Loading state */}
      <div id="collab-loading" className="text-center py-8">
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
/*  Stores I Collaborate With (right card)                             */
/* ------------------------------------------------------------------ */

function StoresICollaborateWithSection() {
  return (
    <section className="intg-card animate-in bento-col-5" id="collab-as-collab-card">
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
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </div>
          <h2 className="intg-title">Stores I Collaborate With</h2>
        </div>
      </div>
      <p className="intg-desc">
        Stores where you've been granted creator access to verify licenses.
      </p>

      <div id="collab-as-collaborator-list" />

      {/* Empty state */}
      <div id="collab-as-collaborator-empty" className="empty-state">
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
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </div>
        <p className="text-sm font-semibold" style={{ fontFamily: "'DM Sans',sans-serif" }}>
          Not collaborating yet.
        </p>
        <p className="text-xs mt-2 max-w-xs mx-auto" style={{ fontFamily: "'DM Sans',sans-serif" }}>
          Accept an invite from another creator to appear here.
        </p>
      </div>

      {/* Loading state */}
      <div id="collab-as-collaborator-loading" className="text-center py-8">
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
