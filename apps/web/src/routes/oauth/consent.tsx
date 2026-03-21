import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
import { authClient } from '@/lib/auth-client';
import '@/styles/oauth-consent.css';

export const Route = createFileRoute('/oauth/consent')({
  component: OAuthConsentPage,
});

interface ScopeInfo {
  label: string;
  desc: string;
  badge: string;
  icon: React.ReactNode;
}

const SCOPE_INFO: Record<string, ScopeInfo> = {
  'verification:read': {
    label: 'Read verification status',
    desc: 'Check if a user is verified on your server',
    badge: 'Read',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <polyline points="9 12 11 14 15 10" />
      </svg>
    ),
  },
  'subjects:read': {
    label: 'Read subject data',
    desc: 'Access verified users and their purchase records',
    badge: 'Read',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8" r="4" />
        <path d="M6 20v-2a6 6 0 0 1 12 0v2" />
      </svg>
    ),
  },
  'cert:issue': {
    label: 'Issue signing certificate',
    desc: 'Request a YUCP code-signing certificate for your developer key',
    badge: 'Sign',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
  },
};

const DEFAULT_SCOPE_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
  </svg>
);

function OAuthConsentPage() {
  const [clientId, setClientId] = useState('');
  const [rawScopes, setRawScopes] = useState<string[]>([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setClientId(params.get('client_id') || '');
    setRawScopes((params.get('scope') || '').trim().split(/\s+/).filter(Boolean));
  }, []);

  const [allowText, setAllowText] = useState('Allow access');
  const [denyText, setDenyText] = useState('Deny');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submitConsent = useCallback(async (accepted: boolean) => {
    setIsSubmitting(true);
    setAllowText(accepted ? 'Authorising\u2026' : 'Allow access');
    setDenyText(accepted ? 'Deny' : 'Denying\u2026');

    try {
      const result = await authClient.oauth2.consent({
        accept: accepted,
      });

      if (result.error) {
        alert(`Error: ${result.error.message || 'Unknown error'}`);
        return;
      }

      const redirectTarget = result.data?.url;
      if (redirectTarget) {
        window.location.href = redirectTarget;
        return;
      }

      window.location.reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      alert(`Network error: ${message}`);
    } finally {
      setIsSubmitting(false);
      setAllowText('Allow access');
      setDenyText('Deny');
    }
  }, []);

  return (
    <div className="oauth-consent-page">
      <BackgroundCanvasRoot />
      <main>
        <div className="consent-card">
          {/* App connector */}
          <div className="app-connector">
            <div className="app-icon client">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
            </div>
            <div className="connector-arrow">
              <div className="connector-dot"></div>
              <div className="connector-line"></div>
              <div className="connector-dot"></div>
            </div>
            <div className="app-icon ours">
              <img src="/Icons/Bag.png" alt="Creator Assistant" />
            </div>
          </div>

          <h1>Authorize application</h1>
          <p className="client-name">
            <code id="client-id-display">{clientId}</code> wants access to your account
          </p>

          <p className="permissions-label">Permissions requested</p>
          <ul className="permissions-list" id="permissions-list">
            {rawScopes.map((scope) => {
              const info = SCOPE_INFO[scope] || {
                label: scope,
                desc: 'Custom permission scope',
                badge: 'Access',
                icon: DEFAULT_SCOPE_ICON,
              };
              return (
                <li key={scope} className="permission-item">
                  <div className="permission-icon">{info.icon}</div>
                  <div className="permission-text">
                    <div className="permission-name">{info.label}</div>
                    <div className="permission-desc">{info.desc}</div>
                  </div>
                  <span className="permission-badge">{info.badge}</span>
                </li>
              );
            })}
          </ul>

          <div className="security-notice">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <p>
              This app will only access the permissions listed above. You can revoke access at any
              time from your dashboard.
            </p>
          </div>

          <div className="actions" id="actions">
            <button
              className="allow-btn"
              id="allow-btn"
              type="button"
              disabled={isSubmitting}
              onClick={() => submitConsent(true)}
            >
              {allowText}
            </button>
            <button
              className="deny-btn"
              id="deny-btn"
              type="button"
              disabled={isSubmitting}
              onClick={() => submitConsent(false)}
            >
              {denyText}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
