import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import '@/styles/sign-in-redirect.css';

export const Route = createFileRoute('/sign-in-redirect')({
  component: SignInRedirectPage,
});

type ViewState = 'loading' | 'error';

function SignInRedirectPage() {
  const [viewState, setViewState] = useState<ViewState>('loading');

  const callbackUrl =
    typeof window !== 'undefined' ? window.location.href.split('#')[0] : '/sign-in-redirect';
  const signInUrl = `/api/auth/sign-in/discord?callbackURL=${encodeURIComponent(callbackUrl)}`;

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
    window.location.href = signInUrl;
  }, [exchangeBootstrapTokens, signInUrl]);

  useEffect(() => {
    startSignIn().catch((err) => {
      console.error('[sign-in] Exception:', err);
      showError();
    });
  }, [startSignIn, showError]);

  return (
    <div className="sign-in-redirect-page">
      {/* Full-page loading overlay (content injected by site.js) */}
      <div id="page-loading-overlay"></div>

      <div
        id="page-content"
        className={viewState === 'loading' ? '' : 'is-visible'}
        style={{ display: undefined }}
      >
        <div
          id="bg-canvas-root"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            zIndex: -20,
            pointerEvents: 'none',
          }}
        ></div>
        {/* Playful Background Stickers */}
        <div
          id="holo-world-0"
          className="absolute top-32 right-1/4 w-32 opacity-80 sticker pointer-events-auto z-0 h-32 hidden sm:block"
          style={{ animationDelay: '-1s' }}
        ></div>
        <div
          id="holo-assistant-1"
          className="absolute bottom-32 left-1/4 w-24 opacity-60 sticker pointer-events-auto z-0 h-24 hidden sm:block"
          style={{ animationDelay: '-4s' }}
        ></div>

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
                <a
                  id="retry-btn"
                  href={callbackUrl}
                  className="brand-gradient-btn inline-block w-full sm:w-auto px-8 py-4 rounded-full text-[#1a6bff] font-bold uppercase tracking-wider no-underline text-center"
                >
                  Try again
                </a>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
