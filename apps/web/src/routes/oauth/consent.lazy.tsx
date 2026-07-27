import { createLazyFileRoute } from '@tanstack/react-router';
import { getOAuthScopeDisplay } from '@yucp/shared';
import { useCallback, useEffect, useState } from 'react';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
import { authClient } from '@/lib/auth-client';
import '@/styles/oauth-consent.css';
import { Icon } from '@/components/ui/Icon';

export const Route = createLazyFileRoute('/oauth/consent')({
  component: OAuthConsentPage,
});

// Scope copy (label/description/badge) lives in @yucp/shared so it never drifts.
// Icons are presentation-only and stay here, keyed by scope.
const SCOPE_ICONS: Record<string, React.ReactNode> = {
  'verification:read': <Icon name="shield" />,
  'subjects:read': <Icon name="user" />,
  'cert:issue': <Icon name="lock" />,
  'profile:read': <Icon name="profile" />,
  'products:read': <Icon name="package" />,
  offline_access: <Icon name="refresh" />,
};

const DEFAULT_SCOPE_ICON = <Icon name="settings" />;

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
      <BackgroundCanvasRoot position="fixed" />
      <main className="relative z-10">
        <div className="consent-card">
          {/* App connector */}
          <div className="app-connector">
            <div className="app-icon client">
              <Icon name="desktop" />
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
            <Icon name="shield" />
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
