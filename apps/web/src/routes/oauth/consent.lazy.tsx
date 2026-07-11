import { createLazyFileRoute } from '@tanstack/react-router';
import { getOAuthScopeDisplay } from '@yucp/shared';
import { useCallback, useEffect, useState } from 'react';
import { CloudBackground } from '@/components/three/CloudBackground';
import { authClient } from '@/lib/auth-client';
import '@/styles/oauth-consent.css';

export const Route = createLazyFileRoute('/oauth/consent')({
  component: OAuthConsentPage,
});

// Scope copy (label/description/badge) lives in @yucp/shared so it never drifts.
// Icons are presentation-only and stay here, keyed by scope.
const SCOPE_ICONS: Record<string, React.ReactNode> = {
  'verification:read': (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  ),
  'subjects:read': (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M6 20v-2a6 6 0 0 1 12 0v2" />
    </svg>
  ),
  'cert:issue': (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  'profile:read': (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20a8 8 0 0 1 16 0" />
    </svg>
  ),
  'products:read': (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  ),
  offline_access: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  ),
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
      <CloudBackground position="fixed" zIndex={-20} />
      <main className="relative z-10">
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
              const display = getOAuthScopeDisplay(scope);
              const icon = SCOPE_ICONS[scope] ?? DEFAULT_SCOPE_ICON;
              return (
                <li key={scope} className="permission-item">
                  <div className="permission-icon">{icon}</div>
                  <div className="permission-text">
                    <div className="permission-name">{display.label}</div>
                    <div className="permission-desc">{display.description}</div>
                  </div>
                  <span className="permission-badge">{display.badge}</span>
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
