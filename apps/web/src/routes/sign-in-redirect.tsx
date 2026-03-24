import { createFileRoute } from '@tanstack/react-router';
import { normalizeAuthRedirectTarget } from '@yucp/shared/authRedirects';
import { useCallback, useEffect, useState } from 'react';
import { useCloudReady } from '@/hooks/useCloudReady';
import { usePageLoadingTransition } from '@/hooks/usePageLoadingTransition';
import { authClient } from '@/lib/auth-client';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { logWebError } from '@/lib/webDiagnostics';

export const Route = createFileRoute('/sign-in-redirect')({
  validateSearch: (search: Record<string, unknown>) => ({
    redirectTo: typeof search.redirectTo === 'string' ? search.redirectTo : undefined,
  }),
  head: () => ({
    links: routeStylesheetLinks(routeStyleHrefs.signInRedirect),
  }),
  component: SignInRedirectPage,
});

type ViewState = 'loading' | 'error';

function SignInRedirectPage() {
  const [viewState, setViewState] = useState<ViewState>('loading');
  const [isVisible, setIsVisible] = useState(false);
  const { redirectTo } = Route.useSearch();
  const postAuthTarget = normalizeAuthRedirectTarget(redirectTo);
  const bgReady = useCloudReady();
  const showPage = usePageLoadingTransition({
    onReveal: () => setIsVisible(true),
    overlayFadeClass: 'is-hiding',
    overlayFadeDelayMs: 400,
    overlayRemoveDelayMs: 650,
  });

  useEffect(() => {
    if (bgReady) showPage();
  }, [bgReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const showError = useCallback(() => {
    setViewState('error');
  }, []);

  const redirectToExpiredLinkError = useCallback(() => {
    const errorUrl = new URL('/verify-error', window.location.origin);
    errorUrl.searchParams.set('error', 'link_expired');
    window.location.replace(errorUrl.toString());
  }, []);

  const exchangeBootstrapTokens = useCallback(async () => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const setupToken = hash.get('s');
    const connectToken = hash.get('token');
    if (!setupToken && !connectToken) return false;

    const bootstrapUrl = new URL('/api/connect/bootstrap', window.location.origin);
    const response = await fetch(bootstrapUrl.toString(), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        setupToken: setupToken || undefined,
        connectToken: connectToken || undefined,
      }),
    });

    if (!response.ok) {
      redirectToExpiredLinkError();
      return true;
    }

    window.history.replaceState({}, '', window.location.pathname + window.location.search);
    window.location.reload();
    return true;
  }, [redirectToExpiredLinkError]);

  const startSignIn = useCallback(async () => {
    if (await exchangeBootstrapTokens()) return;
    await authClient.signIn.social({
      provider: 'discord',
      callbackURL: postAuthTarget,
    });
  }, [exchangeBootstrapTokens, postAuthTarget]);

  const handleRetry = useCallback(async () => {
    setViewState('loading');
    try {
      await authClient.signIn.social({
        provider: 'discord',
        callbackURL: postAuthTarget,
      });
    } catch (error) {
      logWebError('Sign-in retry failed', error, {
        phase: 'sign-in-retry',
        route: '/sign-in-redirect',
      });
      showError();
    }
  }, [postAuthTarget, showError]);

  useEffect(() => {
    startSignIn().catch((err) => {
      logWebError('Sign-in redirect failed', err, {
        phase: 'sign-in-redirect',
        route: '/sign-in-redirect',
      });
      showError();
    });
  }, [startSignIn, showError]);

  return (
    <div className="sign-in-redirect-page">
      <div
        id="page-content"
        className={isVisible ? 'is-visible' : ''}
        style={isVisible ? undefined : { display: 'none' }}
      >
        <main className="text-center max-w-md w-full px-4 sm:px-6">
          <div className="connect-card rounded-[32px] p-8 sm:p-12">
            {viewState === 'loading' && (
              <div id="loading-state">
                <div className="spinner mx-auto mb-6"></div>
                <h1 className="text-2xl md:text-3xl text-[#ffffff] mb-3 fade-up">
                  Signing in with Discord&reg;
                </h1>
                <p className="text-[rgba(255,255,255,0.8)] fade-up">
                  Redirecting you to Discord&reg; to authorize...
                </p>
              </div>
            )}
            {viewState === 'error' && (
              <div id="error-state">
                <svg
                  className="w-16 h-16 mx-auto text-[#c53030] mb-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  ></path>
                </svg>
                <h1 className="text-xl text-[#ffffff] mb-3">Sign-in failed</h1>
                <p className="text-[rgba(255,255,255,0.8)] mb-6">
                  Something went wrong. Please try again.
                </p>
                <button
                  id="retry-btn"
                  type="button"
                  className="brand-gradient-btn inline-block w-full sm:w-auto px-8 py-4 rounded-full text-[#1a6bff] font-bold uppercase tracking-wider no-underline text-center"
                  onClick={handleRetry}
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
