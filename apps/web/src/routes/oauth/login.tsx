import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithDiagnostics } from '@/api/client';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import { CloudBackground } from '@/components/three/CloudBackground';
import { Icon } from '@/components/ui/Icon';
import { usePageLoadingTransition } from '@/hooks/usePageLoadingTransition';
import { authClient } from '@/lib/auth-client';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { logWebError } from '@/lib/webDiagnostics';

export const Route = createFileRoute('/oauth/login')({
  head: () => ({
    links: routeStylesheetLinks(routeStyleHrefs.oauthLogin),
  }),
  component: OAuthLoginPage,
});

type ViewState = 'loading' | 'error';

function getSignedOAuthQuery(search: string): URLSearchParams | null {
  const params = new URLSearchParams(search);
  if (!params.has('sig')) {
    return null;
  }

  const signedParams = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    signedParams.append(key, value);
    if (key === 'sig') {
      break;
    }
  }

  return signedParams;
}

function buildOAuthResumePath(search: string): string | null {
  const signedParams = getSignedOAuthQuery(search);
  if (!signedParams) {
    return null;
  }

  signedParams.delete('exp');
  signedParams.delete('sig');
  const originalQuery = signedParams.toString();
  if (!originalQuery) {
    return null;
  }

  return `/api/auth/oauth2/authorize?${originalQuery}`;
}

function OAuthLoginPage() {
  return (
    <>
      <CloudBackground variant="default" />
      <OAuthLoginPageContent />
    </>
  );
}

function OAuthLoginPageContent() {
  const [viewState, setViewState] = useState<ViewState>('loading');
  const [isVisible, setIsVisible] = useState(false);
  const retryPathRef = useRef('/oauth/login');

  const showPage = usePageLoadingTransition({
    onReveal: () => setIsVisible(true),
    visibleClass: 'visible',
    overlayFadeClass: 'fade-out',
    overlayFadeDelayMs: 350,
    overlayRemoveDelayMs: 650,
  });

  useEffect(() => {
    showPage();
  }, [showPage]);

  useEffect(() => {
    retryPathRef.current = `${window.location.pathname}${window.location.search}`;
  }, []);

  const showError = useCallback(() => {
    setViewState('error');
  }, []);

  const resumeOAuthFlow = useCallback(async () => {
    const resumePath = buildOAuthResumePath(window.location.search);
    if (!resumePath) {
      showError();
      return;
    }

    const response = await fetchWithDiagnostics(resumePath, {
      headers: {
        accept: 'application/json',
      },
    });

    const redirectPayload = (await response.json().catch(() => null)) as {
      redirect?: boolean;
      url?: string;
    } | null;
    const redirectTarget =
      redirectPayload?.redirect && redirectPayload.url
        ? redirectPayload.url
        : response.headers.get('location');

    if (!redirectTarget) {
      throw new Error('OAuth authorize resume did not provide a redirect target');
    }

    window.location.assign(redirectTarget);
  }, [showError]);

  const runOAuthLoginFlow = useCallback(async () => {
    const sessionResult = await authClient.getSession();
    if (sessionResult.data?.session || sessionResult.data?.user) {
      await resumeOAuthFlow();
      return;
    }

    await authClient.signIn.social({
      provider: 'discord',
      callbackURL: window.location.href,
    });
  }, [resumeOAuthFlow]);

  useEffect(() => {
    runOAuthLoginFlow().catch((err) => {
      logWebError('OAuth login failed', err, {
        phase: 'oauth-login',
        route: '/oauth/login',
      });
      showError();
    });
  }, [runOAuthLoginFlow, showError]);

  return (
    <div className="oauth-login-page">
      <PageLoadingOverlay />
      <div id="page-content" className={isVisible ? 'visible' : ''}>
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
                  <Icon name="alert" />
                </div>
                <h1>Sign-in failed</h1>
                <p className="subtitle">Something went wrong during the authorization flow.</p>
                <div className="error-notice">
                  <Icon name="alert" />
                  <p>
                    The sign-in could not be completed. This can happen if you denied access, the
                    session expired, or there was a network issue. Please try again.
                  </p>
                </div>
                <a id="retry-btn" href={retryPathRef.current} className="retry-btn">
                  <Icon name="refresh" />
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
