import { createFileRoute, redirect } from '@tanstack/react-router';
import { normalizeAuthRedirectTarget } from '@yucp/shared/authRedirects';
import { useCallback, useEffect, useState } from 'react';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import { CloudBackground } from '@/components/three/CloudBackground';
import { usePageLoadingTransition } from '@/hooks/usePageLoadingTransition';
import {
  startAccountRecovery,
  verifyAccountRecoveryBackupCode,
  verifyAccountRecoveryEmail,
} from '@/lib/account';
import { authClient } from '@/lib/auth-client';
import {
  CREATOR_SUITE_LOGO_SRC,
  CREATOR_SUITE_PRODUCT_NAME,
  CREATOR_SUITE_SIGN_IN_METHODS,
  CreatorSuiteSignInMethodIcon,
  type CreatorSuiteSignInMethodId,
} from '@/lib/creatorSuiteSignIn';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { getAuthSession } from '@/lib/server/auth';
import { logWebError } from '@/lib/webDiagnostics';

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>) => ({
    redirectTo: typeof search.redirectTo === 'string' ? search.redirectTo : undefined,
  }),
  head: () => ({
    meta: [{ title: `Sign in | ${CREATOR_SUITE_PRODUCT_NAME}` }],
    links: routeStylesheetLinks(routeStyleHrefs.signIn),
  }),
  beforeLoad: async ({ search }) => {
    const session = await getAuthSession();

    if (session.isAuthenticated) {
      const target = normalizeAuthRedirectTarget(search.redirectTo);
      throw redirect({ to: target });
    }
  },
  component: SignInRouteComponent,
});

type PageState = 'state-signin' | 'state-loading' | 'state-error';
type RecoveryStep = 'lookup' | 'challenge' | 'enroll';

function SignInRouteComponent() {
  const { redirectTo } = Route.useSearch();
  return <SignInPage redirectTo={redirectTo} />;
}

export function SignInPage({ redirectTo }: Readonly<{ redirectTo?: string | null }>) {
  return (
    <>
      <CloudBackground variant="default" />
      <SignInPageContent redirectTo={redirectTo} />
    </>
  );
}

function SignInPageContent({ redirectTo }: Readonly<{ redirectTo?: string | null }>) {
  const [currentState, setCurrentState] = useState<PageState>('state-signin');
  const [isVisible, setIsVisible] = useState(false);
  const [errorMessage, setErrorMessage] = useState('Something went wrong. Please try again.');
  const [authAction, setAuthAction] = useState<CreatorSuiteSignInMethodId | null>(null);
  const [isRecoveryOpen, setIsRecoveryOpen] = useState(false);
  const [recoveryStep, setRecoveryStep] = useState<RecoveryStep>('lookup');
  const [recoveryPendingAction, setRecoveryPendingAction] = useState<
    'start' | 'verify-email' | 'verify-backup-code' | 'enroll-passkey' | null
  >(null);
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [recoveryOtp, setRecoveryOtp] = useState('');
  const [recoveryBackupCode, setRecoveryBackupCode] = useState('');
  const [recoveryPasskeyContext, setRecoveryPasskeyContext] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const redirectTarget = normalizeAuthRedirectTarget(redirectTo);

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

  const showError = useCallback(
    (msg?: string) => {
      setCurrentState('state-error');
      setAuthAction(null);
      if (msg) setErrorMessage(msg);
      showPage();
    },
    [showPage]
  );

  const resetRecoveryFlow = useCallback(() => {
    setRecoveryStep('lookup');
    setRecoveryOtp('');
    setRecoveryBackupCode('');
    setRecoveryPasskeyContext(null);
    setRecoveryMessage(null);
    setRecoveryError(null);
    setRecoveryPendingAction(null);
  }, []);

  const handleSignIn = useCallback(async () => {
    setAuthAction('discord');
    setCurrentState('state-loading');
    try {
      await authClient.signIn.social({
        provider: 'discord',
        callbackURL: redirectTarget,
      });
    } catch (error) {
      logWebError('Sign-in start failed', error, {
        phase: 'sign-in-click',
        route: '/sign-in',
      });
      showError('Failed to start sign-in. Please try again.');
    }
  }, [redirectTarget, showError]);

  const handlePasskeySignIn = useCallback(async () => {
    setAuthAction('passkey');
    setCurrentState('state-loading');
    try {
      const result = await authClient.signIn.passkey();
      if (result.error) {
        throw new Error(result.error.message ?? 'Passkey sign-in was cancelled.');
      }
      window.location.assign(redirectTarget);
    } catch (error) {
      logWebError('Passkey sign-in failed', error, {
        phase: 'passkey-sign-in',
        route: '/sign-in',
      });
      showError(error instanceof Error ? error.message : 'Passkey sign-in could not be completed.');
    } finally {
      setAuthAction(null);
    }
  }, [redirectTarget, showError]);

  const handleCreatorSuiteSignIn = useCallback(
    (id: CreatorSuiteSignInMethodId) => {
      switch (id) {
        case 'discord':
          void handleSignIn();
          break;
        case 'passkey':
          void handlePasskeySignIn();
          break;
        default: {
          const _exhaustive: never = id;
          void _exhaustive;
        }
      }
    },
    [handlePasskeySignIn, handleSignIn]
  );

  const handleStartRecovery = useCallback(async () => {
    if (!recoveryEmail.trim()) {
      setRecoveryError('Enter the email address tied to the account or recovery contact.');
      return;
    }

    setRecoveryPendingAction('start');
    setRecoveryError(null);
    try {
      const result = await startAccountRecovery(recoveryEmail.trim());
      setRecoveryStep('challenge');
      setRecoveryMessage(result.message);
      setRecoveryOtp('');
      setRecoveryBackupCode('');
    } catch (error) {
      setRecoveryError(
        error instanceof Error ? error.message : 'Recovery could not be started right now.'
      );
    } finally {
      setRecoveryPendingAction(null);
    }
  }, [recoveryEmail]);

  const handleVerifyRecoveryEmail = useCallback(async () => {
    if (!recoveryEmail.trim() || !recoveryOtp.trim()) {
      setRecoveryError('Enter the recovery email and the code that was sent to it.');
      return;
    }

    setRecoveryPendingAction('verify-email');
    setRecoveryError(null);
    try {
      const result = await verifyAccountRecoveryEmail(recoveryEmail.trim(), recoveryOtp.trim());
      setRecoveryPasskeyContext(result.recoveryPasskeyContext);
      setRecoveryStep('enroll');
      setRecoveryMessage('Recovery verified. Add a new passkey to finish restoring access.');
    } catch (error) {
      setRecoveryError(
        error instanceof Error ? error.message : 'That recovery code was not valid.'
      );
    } finally {
      setRecoveryPendingAction(null);
    }
  }, [recoveryEmail, recoveryOtp]);

  const handleVerifyBackupCode = useCallback(async () => {
    if (!recoveryEmail.trim() || !recoveryBackupCode.trim()) {
      setRecoveryError('Enter the account email and one backup code.');
      return;
    }

    setRecoveryPendingAction('verify-backup-code');
    setRecoveryError(null);
    try {
      const result = await verifyAccountRecoveryBackupCode(
        recoveryEmail.trim(),
        recoveryBackupCode.trim()
      );
      setRecoveryPasskeyContext(result.recoveryPasskeyContext);
      setRecoveryStep('enroll');
      setRecoveryMessage('Backup code accepted. Add a new passkey to finish restoring access.');
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : 'That backup code was not valid.');
    } finally {
      setRecoveryPendingAction(null);
    }
  }, [recoveryBackupCode, recoveryEmail]);

  const handleCompleteRecovery = useCallback(async () => {
    if (!recoveryPasskeyContext) {
      setRecoveryError('Recovery verification expired. Start again.');
      setRecoveryStep('lookup');
      return;
    }
    setRecoveryPendingAction('enroll-passkey');
    setRecoveryError(null);
    setCurrentState('state-loading');
    try {
      const addPasskeyResult = await authClient.passkey.addPasskey({
        context: recoveryPasskeyContext,
      });
      if (addPasskeyResult.error) {
        throw new Error(
          addPasskeyResult.error.message ?? 'Could not register the recovery passkey.'
        );
      }

      const signInResult = await authClient.signIn.passkey();
      if (signInResult.error) {
        throw new Error(
          signInResult.error.message ??
            'Passkey was added, but sign-in still needs to be completed.'
        );
      }
      window.location.assign(redirectTarget);
    } catch (error) {
      setCurrentState('state-signin');
      setRecoveryError(error instanceof Error ? error.message : 'Recovery could not be completed.');
    } finally {
      setRecoveryPendingAction(null);
    }
  }, [recoveryPasskeyContext, redirectTarget]);

  useEffect(() => {
    setCurrentState('state-signin');
  }, []);

  return (
    <div className="sign-in-page">
      <PageLoadingOverlay />
      <div id="page-content" className={isVisible ? 'visible' : ''}>
        <div className="logo-wrap logo-wrap--suite">
          <img src={CREATOR_SUITE_LOGO_SRC} alt={CREATOR_SUITE_PRODUCT_NAME} />
        </div>

        <div className="card">
          {currentState === 'state-signin' && (
            <div id="state-signin" className="state active">
              <h1 className="card-title">Sign in</h1>
              <p className="card-sub">Use Discord or a passkey to access your creator account.</p>

              <fieldset className="sign-in-actions sign-in-methods">
                <legend className="sign-in-sr-only">Sign-in options</legend>
                {CREATOR_SUITE_SIGN_IN_METHODS.map((method) => (
                  <button
                    key={method.id}
                    id={method.id === 'discord' ? 'discord-signin-btn' : undefined}
                    type="button"
                    className={
                      method.visual === 'brand'
                        ? 'sign-in-method sign-in-method--brand discord-btn'
                        : 'sign-in-method sign-in-method--neutral secondary-auth-btn'
                    }
                    onClick={() => handleCreatorSuiteSignIn(method.id)}
                    disabled={authAction !== null}
                  >
                    {authAction === method.id ? <span className="sign-in-btn-spinner" /> : null}
                    <CreatorSuiteSignInMethodIcon name={method.id} />
                    {authAction === method.id ? method.loadingLabel : method.label}
                  </button>
                ))}
              </fieldset>

              <div className="sign-in-recovery-row">
                <button
                  type="button"
                  className="sign-in-trouble-link"
                  aria-expanded={isRecoveryOpen}
                  onClick={() => {
                    setIsRecoveryOpen((value) => !value);
                    if (isRecoveryOpen) {
                      resetRecoveryFlow();
                    }
                  }}
                >
                  {isRecoveryOpen ? 'Close account recovery' : "Can't sign in?"}
                </button>
              </div>

              {isRecoveryOpen ? (
                <div className="recovery-panel">
                  <label className="recovery-label" htmlFor="recovery-email">
                    Account or recovery email
                  </label>
                  <input
                    id="recovery-email"
                    className="recovery-input"
                    type="email"
                    value={recoveryEmail}
                    onChange={(event) => setRecoveryEmail(event.target.value)}
                    placeholder="owner@example.com"
                    autoComplete="email"
                  />

                  {recoveryStep === 'lookup' ? (
                    <button
                      type="button"
                      className="recovery-submit-btn"
                      onClick={handleStartRecovery}
                      disabled={recoveryPendingAction !== null}
                    >
                      {recoveryPendingAction === 'start' ? (
                        <span className="sign-in-btn-spinner" />
                      ) : null}
                      {recoveryPendingAction === 'start'
                        ? 'Starting recovery...'
                        : 'Send recovery options'}
                    </button>
                  ) : null}

                  {recoveryStep === 'challenge' ? (
                    <div className="recovery-challenges">
                      <div className="recovery-challenge-card">
                        <label className="recovery-label" htmlFor="recovery-otp">
                          Email code
                        </label>
                        <input
                          id="recovery-otp"
                          className="recovery-input"
                          type="text"
                          value={recoveryOtp}
                          onChange={(event) => setRecoveryOtp(event.target.value)}
                          placeholder="123456"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                        />
                        <button
                          type="button"
                          className="recovery-submit-btn"
                          onClick={handleVerifyRecoveryEmail}
                          disabled={recoveryPendingAction !== null}
                        >
                          {recoveryPendingAction === 'verify-email' ? (
                            <span className="sign-in-btn-spinner" />
                          ) : null}
                          {recoveryPendingAction === 'verify-email'
                            ? 'Verifying code...'
                            : 'Verify email code'}
                        </button>
                      </div>

                      <div className="recovery-challenge-card">
                        <label className="recovery-label" htmlFor="recovery-backup-code">
                          Backup code
                        </label>
                        <input
                          id="recovery-backup-code"
                          className="recovery-input"
                          type="text"
                          value={recoveryBackupCode}
                          onChange={(event) => setRecoveryBackupCode(event.target.value)}
                          placeholder="XXXXXXXXXX"
                          autoComplete="one-time-code"
                        />
                        <button
                          type="button"
                          className="recovery-submit-btn recovery-submit-btn--secondary"
                          onClick={handleVerifyBackupCode}
                          disabled={recoveryPendingAction !== null}
                        >
                          {recoveryPendingAction === 'verify-backup-code' ? (
                            <span className="sign-in-btn-spinner" />
                          ) : null}
                          {recoveryPendingAction === 'verify-backup-code'
                            ? 'Checking backup code...'
                            : 'Use backup code'}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {recoveryStep === 'enroll' ? (
                    <div className="recovery-enroll-card">
                      <p className="recovery-panel-title">Finish recovery with a new passkey</p>
                      <p className="recovery-panel-copy">
                        Your recovery proof is verified. Register a fresh passkey now—we will
                        complete sign-in with that passkey right after.
                      </p>
                      <button
                        type="button"
                        className="recovery-submit-btn"
                        onClick={handleCompleteRecovery}
                        disabled={recoveryPendingAction !== null}
                      >
                        {recoveryPendingAction === 'enroll-passkey' ? (
                          <span className="sign-in-btn-spinner" />
                        ) : null}
                        {recoveryPendingAction === 'enroll-passkey'
                          ? 'Registering passkey...'
                          : 'Register recovery passkey'}
                      </button>
                    </div>
                  ) : null}

                  {recoveryMessage ? <p className="recovery-message">{recoveryMessage}</p> : null}
                  {recoveryError ? <p className="recovery-error">{recoveryError}</p> : null}

                  <div className="recovery-footer">
                    <button
                      type="button"
                      className="recovery-reset-btn"
                      onClick={resetRecoveryFlow}
                      disabled={recoveryPendingAction !== null}
                    >
                      Start over
                    </button>
                    <p className="recovery-support-note">
                      If Discord and email are both compromised, use your backup codes or contact
                      support for a manual recovery review.
                    </p>
                  </div>
                </div>
              ) : null}

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
                <p>
                  {authAction === 'passkey'
                    ? 'Completing passkey sign-in...'
                    : 'Completing sign-in...'}
                </p>
                <div className="loading-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
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
              <div className="sign-in-actions">
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
                  Try Discord again
                </button>
                <button
                  type="button"
                  className="secondary-auth-btn"
                  onClick={() => {
                    setCurrentState('state-signin');
                    setErrorMessage('Something went wrong. Please try again.');
                  }}
                >
                  Back to sign-in
                </button>
              </div>
            </div>
          )}
        </div>

        <p className="outer-footer">
          {CREATOR_SUITE_PRODUCT_NAME} · <a href="/legal/privacy-policy">Privacy</a> ·{' '}
          <a href="/legal/terms-of-service">Terms</a>
        </p>
      </div>
    </div>
  );
}
