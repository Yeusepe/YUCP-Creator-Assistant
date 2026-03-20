import { createFileRoute, redirect } from '@tanstack/react-router';
import { getSafeRelativeRedirectTarget } from '@yucp/shared/authRedirects';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';

export const Route = createFileRoute('/oauth/login')({
  beforeLoad: ({ context, location }) => {
    if (context.isAuthenticated) {
      throw redirect({
        to: '/oauth/consent',
        search: location.search,
      });
    }
  },
  head: () => ({
    links: routeStylesheetLinks(routeStyleHrefs.oauthLogin),
  }),
  component: OAuthLoginPage,
});

type ViewState = 'loading' | 'error';

function OAuthLoginPage() {
  const [viewState, setViewState] = useState<ViewState>('loading');
  const retryPathRef = useRef('/oauth/login');

  useEffect(() => {
    retryPathRef.current = window.location.pathname;
  }, []);

  const showError = useCallback(() => {
    setViewState('error');
  }, []);

  const runOAuthLoginFlow = useCallback(async () => {
    const returnTo =
      getSafeRelativeRedirectTarget(window.location.pathname + window.location.search) ??
      '/oauth/login';
    await authClient.signIn.social({
      provider: 'discord',
      callbackURL: returnTo,
    });
  }, []);

  useEffect(() => {
    retryPathRef.current =
      getSafeRelativeRedirectTarget(window.location.pathname + window.location.search) ??
      '/oauth/login';
  }, []);

  useEffect(() => {
    runOAuthLoginFlow().catch((err) => {
      console.error('[oauth-login] Exception:', err);
      showError();
    });
  }, [runOAuthLoginFlow, showError]);

  return (
    <div className="oauth-login-page">
      <main>
        <div className="login-card">
          {/* Loading state */}
          {viewState === 'loading' && (
            <div id="loading-state">
              <div className="spinner-ring"></div>
              <h1>Signing in with Discord</h1>
              <p className="subtitle">Redirecting you to authorize&hellip;</p>
              <div className="loading-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          )}

          {/* Error state */}
          {viewState === 'error' && (
            <div id="error-state">
              <div className="error-icon">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <h1>Sign-in failed</h1>
              <p className="subtitle">Something went wrong during the authorization flow.</p>
              <div className="error-notice">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <p>
                  The sign-in could not be completed. This can happen if you denied access, the
                  session expired, or there was a network issue. Please try again.
                </p>
              </div>
              <a id="retry-btn" href={retryPathRef.current} className="retry-btn">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                Try again
              </a>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
