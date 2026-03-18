import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { normalizeAuthRedirectTarget } from '@yucp/shared/authRedirects';
import { useCallback, useEffect, useState } from 'react';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import { CloudBackground } from '@/components/three/CloudBackground';
import { usePageLoadingTransition } from '@/hooks/usePageLoadingTransition';
import { authClient } from '@/lib/auth-client';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>) => ({
    redirectTo: typeof search.redirectTo === 'string' ? search.redirectTo : undefined,
  }),
  head: () => ({
    meta: [{ title: 'Sign in | Creator Assistant' }],
    links: routeStylesheetLinks(routeStyleHrefs.signIn),
  }),
  component: SignInRouteComponent,
});

type PageState = 'state-signin' | 'state-loading' | 'state-authenticated' | 'state-error';

function SignInRouteComponent() {
  const { redirectTo } = Route.useSearch();
  return <SignInPage redirectTo={redirectTo} />;
}

export function SignInPage({ redirectTo }: Readonly<{ redirectTo?: string | null }>) {
  const [currentState, setCurrentState] = useState<PageState>('state-signin');
  const [isVisible, setIsVisible] = useState(false);
  const [errorMessage, setErrorMessage] = useState('Something went wrong. Please try again.');
  const redirectTarget = normalizeAuthRedirectTarget(redirectTo);
  const navigate = useNavigate();

  const showPage = usePageLoadingTransition({
    onReveal: () => setIsVisible(true),
    visibleClass: 'visible',
    overlayFadeClass: 'fade-out',
    overlayFadeDelayMs: 350,
    overlayRemoveDelayMs: 650,
  });

  const showError = useCallback(
    (msg?: string) => {
      setCurrentState('state-error');
      if (msg) setErrorMessage(msg);
      showPage();
    },
    [showPage]
  );

  const handleSignIn = useCallback(async () => {
    setCurrentState('state-loading');
    try {
      await authClient.signIn.social({
        provider: 'discord',
        callbackURL: redirectTarget,
      });
    } catch {
      showError('Failed to start sign-in. Please try again.');
    }
  }, [redirectTarget, showError]);

  useEffect(() => {
    let isCancelled = false;

    const checkSession = async () => {
      try {
        const session = await authClient.getSession();
        if (!isCancelled && session.data?.user) {
          setCurrentState('state-authenticated');
          showPage();
          window.setTimeout(() => {
            if (!isCancelled) {
              navigate({ to: redirectTarget, replace: true });
            }
          }, 150);
          return;
        }
      } catch {
        // Session check failed -- show sign-in button
      }

      if (!isCancelled) {
        setCurrentState('state-signin');
        showPage();
      }
    };

    checkSession();

    return () => {
      isCancelled = true;
    };
  }, [redirectTarget, showPage, navigate]);

  return (
    <div className="sign-in-page">
      <PageLoadingOverlay />

      <CloudBackground variant="default" />

      <div id="page-content" className={isVisible ? 'visible' : ''}>
        <div className="logo-wrap">
          <img src="/Icons/MainLogo.png" alt="Creator Assistant" />
        </div>

        <div className="card">
          {currentState === 'state-signin' && (
            <div id="state-signin" className="state active">
              <div className="brand-icon" aria-hidden="true">
                <svg
                  width="26"
                  height="20"
                  viewBox="0 0 22 16"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    d="M18.6405 1.34005C17.2162 0.692466 15.6894 0.214918 14.0937 -0.000976562C13.8964 0.351023 13.668 0.827571 13.5104 1.20625C11.8109 0.957596 10.1272 0.957596 8.45984 1.20625C8.30222 0.827571 8.06802 0.351023 7.86887 -0.000976562C6.27139 0.214918 4.74277 0.694558 3.31851 1.34394C0.477068 5.53193 -0.29243 9.61536 0.0923454 13.6397C2.01043 15.0637 3.86783 15.9288 5.69467 16.4888C6.14896 15.8688 6.55408 15.2091 6.90196 14.5152C6.23869 14.2665 5.60335 13.9559 5.0046 13.5937C5.16222 13.4775 5.31618 13.3572 5.46618 13.2369C9.00034 14.9215 12.8434 14.9215 16.3356 13.2369C16.4875 13.3572 16.6415 13.4775 16.7972 13.5937C16.1965 13.9578 15.5592 14.2684 14.8959 14.5171C15.2438 15.2091 15.6471 15.8707 16.1032 16.4907C17.932 15.9307 19.7913 15.0656 21.7094 13.6397C22.1637 8.99328 20.9479 4.94768 18.6405 1.34005ZM7.35277 11.1872C6.27139 11.1872 5.38261 10.1885 5.38261 8.96893C5.38261 7.74936 6.25165 6.74884 7.35277 6.74884C8.4539 6.74884 9.34267 7.74756 9.32294 8.96893C9.32479 10.1885 8.4539 11.1872 7.35277 11.1872ZM14.449 11.1872C13.3677 11.1872 12.4789 10.1885 12.4789 8.96893C12.4789 7.74936 13.3479 6.74884 14.449 6.74884C15.5502 6.74884 16.439 7.74756 16.4192 8.96893C16.4192 10.1885 15.5502 11.1872 14.449 11.1872Z"
                    fill="rgba(114,137,218,0.9)"
                  />
                </svg>
              </div>

              <h1 className="card-title">Creator Assistant</h1>
              <p className="card-sub">
                Sign in with Discord to access your dashboard and manage your server integrations.
              </p>

              <button
                id="discord-signin-btn"
                type="button"
                className="discord-btn"
                onClick={handleSignIn}
              >
                <svg
                  width="20"
                  height="15"
                  viewBox="0 0 22 16"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    d="M18.6405 1.34005C17.2162 0.692466 15.6894 0.214918 14.0937 -0.000976562C13.8964 0.351023 13.668 0.827571 13.5104 1.20625C11.8109 0.957596 10.1272 0.957596 8.45984 1.20625C8.30222 0.827571 8.06802 0.351023 7.86887 -0.000976562C6.27139 0.214918 4.74277 0.694558 3.31851 1.34394C0.477068 5.53193 -0.29243 9.61536 0.0923454 13.6397C2.01043 15.0637 3.86783 15.9288 5.69467 16.4888C6.14896 15.8688 6.55408 15.2091 6.90196 14.5152C6.23869 14.2665 5.60335 13.9559 5.0046 13.5937C5.16222 13.4775 5.31618 13.3572 5.46618 13.2369C9.00034 14.9215 12.8434 14.9215 16.3356 13.2369C16.4875 13.3572 16.6415 13.4775 16.7972 13.5937C16.1965 13.9578 15.5592 14.2684 14.8959 14.5171C15.2438 15.2091 15.6471 15.8707 16.1032 16.4907C17.932 15.9307 19.7913 15.0656 21.7094 13.6397C22.1637 8.99328 20.9479 4.94768 18.6405 1.34005ZM7.35277 11.1872C6.27139 11.1872 5.38261 10.1885 5.38261 8.96893C5.38261 7.74936 6.25165 6.74884 7.35277 6.74884C8.4539 6.74884 9.34267 7.74756 9.32294 8.96893C9.32479 10.1885 8.4539 11.1872 7.35277 11.1872ZM14.449 11.1872C13.3677 11.1872 12.4789 10.1885 12.4789 8.96893C12.4789 7.74936 13.3479 6.74884 14.449 6.74884C15.5502 6.74884 16.439 7.74756 16.4192 8.96893C16.4192 10.1885 15.5502 11.1872 14.449 11.1872Z"
                    fill="white"
                  />
                </svg>
                Sign in with Discord&reg;
              </button>

              <div className="security-note">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                Secure OAuth 2.0 + PKCE &middot; No password stored
              </div>

              <p className="terms-note">
                By signing in you agree to our{' '}
                <a href="/legal/terms-of-service">Terms of Service</a> and{' '}
                <a href="/legal/privacy-policy">Privacy Policy</a>.
              </p>
            </div>
          )}

          {currentState === 'state-loading' && (
            <div id="state-loading" className="state active">
              <div className="inner-spinner">
                <div className="inner-spinner-ring"></div>
                <p>Completing sign-in&hellip;</p>
                <div className="loading-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            </div>
          )}

          {currentState === 'state-authenticated' && (
            <div id="state-authenticated" className="state active">
              <div
                className="brand-icon"
                style={{ background: 'rgba(0,230,118,0.1)', borderColor: 'rgba(0,230,118,0.25)' }}
                aria-hidden="true"
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#00e676"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </div>
              <h1 className="card-title" style={{ marginBottom: '0.4rem' }}>
                You're signed in
              </h1>
              <p className="card-sub" style={{ marginBottom: '1.5rem' }}>
                Redirecting to your dashboard&hellip;
              </p>
              <a id="dashboard-link" href={redirectTarget} className="goto-btn">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                </svg>
                Open Dashboard
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </a>
            </div>
          )}

          {currentState === 'state-error' && (
            <div id="state-error" className="state active">
              <div className="error-icon" aria-hidden="true">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#f87171"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <h1 className="card-title" style={{ fontSize: '1.2rem', marginBottom: '0.4rem' }}>
                Sign-in failed
              </h1>
              <div className="error-notice">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#f87171"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <p id="error-detail">{errorMessage}</p>
              </div>
              <button id="retry-btn" type="button" className="discord-btn" onClick={handleSignIn}>
                <svg
                  width="20"
                  height="15"
                  viewBox="0 0 22 16"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    d="M18.6405 1.34005C17.2162 0.692466 15.6894 0.214918 14.0937 -0.000976562C13.8964 0.351023 13.668 0.827571 13.5104 1.20625C11.8109 0.957596 10.1272 0.957596 8.45984 1.20625C8.30222 0.827571 8.06802 0.351023 7.86887 -0.000976562C6.27139 0.214918 4.74277 0.694558 3.31851 1.34394C0.477068 5.53193 -0.29243 9.61536 0.0923454 13.6397C2.01043 15.0637 3.86783 15.9288 5.69467 16.4888C6.14896 15.8688 6.55408 15.2091 6.90196 14.5152C6.23869 14.2665 5.60335 13.9559 5.0046 13.5937C5.16222 13.4775 5.31618 13.3572 5.46618 13.2369C9.00034 14.9215 12.8434 14.9215 16.3356 13.2369C16.4875 13.3572 16.6415 13.4775 16.7972 13.5937C16.1965 13.9578 15.5592 14.2684 14.8959 14.5171C15.2438 15.2091 15.6471 15.8707 16.1032 16.4907C17.932 15.9307 19.7913 15.0656 21.7094 13.6397C22.1637 8.99328 20.9479 4.94768 18.6405 1.34005ZM7.35277 11.1872C6.27139 11.1872 5.38261 10.1885 5.38261 8.96893C5.38261 7.74936 6.25165 6.74884 7.35277 6.74884C8.4539 6.74884 9.34267 7.74756 9.32294 8.96893C9.32479 10.1885 8.4539 11.1872 7.35277 11.1872ZM14.449 11.1872C13.3677 11.1872 12.4789 10.1885 12.4789 8.96893C12.4789 7.74936 13.3479 6.74884 14.449 6.74884C15.5502 6.74884 16.439 7.74756 16.4192 8.96893C16.4192 10.1885 15.5502 11.1872 14.449 11.1872Z"
                    fill="white"
                  />
                </svg>
                Try again
              </button>
            </div>
          )}
        </div>

        <p className="outer-footer">
          Creator Assistant &middot; <a href="/legal/privacy-policy">Privacy</a> &middot;{' '}
          <a href="/legal/terms-of-service">Terms</a>
        </p>
      </div>
    </div>
  );
}
