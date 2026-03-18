import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { buildAbsoluteCallbackUrl, buildDiscordSignInUrl } from '@/lib/authUrls';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { useRuntimeConfig } from '@/lib/runtimeConfig';

export const Route = createFileRoute('/oauth/login')({
  head: () => ({
    links: routeStylesheetLinks(routeStyleHrefs.oauthLogin),
  }),
  component: OAuthLoginPage,
});

const STORAGE_KEY = 'better-auth_cookie';

type ViewState = 'loading' | 'error';

function OAuthLoginPage() {
  const [viewState, setViewState] = useState<ViewState>('loading');
  const retryPathRef = useRef('/oauth/login');
  const { browserAuthBaseUrl } = useRuntimeConfig();

  useEffect(() => {
    retryPathRef.current = window.location.pathname;
  }, []);

  const showError = useCallback(() => {
    setViewState('error');
  }, []);

  const checkSession = useCallback(async () => {
    const storedCookie = localStorage.getItem(STORAGE_KEY) || '';
    const headers: Record<string, string> = storedCookie
      ? { 'Better-Auth-Cookie': storedCookie }
      : {};
    try {
      const res = await fetch('/api/auth/get-session', {
        credentials: 'include',
        headers,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.user ? data : null;
    } catch {
      return null;
    }
  }, []);

  const exchangeOneTimeToken = useCallback(async () => {
    const params = new URLSearchParams(window.location.search);
    const ott = params.get('ott');
    if (!ott) return false;

    try {
      const res = await fetch('/api/auth/cross-domain/one-time-token/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token: ott }),
      });
      if (res.ok) {
        const setCookie = res.headers.get('set-better-auth-cookie');
        if (setCookie) {
          localStorage.setItem(STORAGE_KEY, setCookie);
        }
      }
    } catch (e) {
      console.error('[oauth-login] OTT exchange failed:', e);
    }

    // Strip the ott token from the URL so it can't be replayed or leaked.
    params.delete('ott');
    const newSearch = params.toString();
    window.history.replaceState(
      {},
      '',
      window.location.pathname + (newSearch ? `?${newSearch}` : '')
    );
    return true;
  }, []);

  const runOAuthLoginFlow = useCallback(async () => {
    // Step 1, if returning from Discord OAuth, exchange OTT for session.
    await exchangeOneTimeToken();

    // Step 2, check whether we now have a session.
    const sessionData = await checkSession();
    if (sessionData?.user) {
      // Signed in: redirect back to the consent page using the signed OAuth
      // params that Better Auth placed on this page's query string.
      const consentUrl = `/oauth/consent${window.location.search}`;
      window.location.replace(consentUrl);
      return;
    }

    // Step 3, not signed in: send user to Discord with this page as callback
    const callbackUrl = buildAbsoluteCallbackUrl(
      window.location.pathname + window.location.search,
      browserAuthBaseUrl
    );
    const signInUrl = buildDiscordSignInUrl(callbackUrl);
    window.location.href = signInUrl;
  }, [browserAuthBaseUrl, exchangeOneTimeToken, checkSession]);

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
