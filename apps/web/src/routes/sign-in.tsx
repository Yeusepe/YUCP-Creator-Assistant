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
  const [recoveryLookupEmail, setRecoveryLookupEmail] = useState<string | null>(null);
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
    setRecoveryLookupEmail(null);
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
      const lookupEmail = recoveryEmail.trim();
      const result = await startAccountRecovery(lookupEmail);
      setRecoveryLookupEmail(lookupEmail);
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
    const lookupEmail = recoveryLookupEmail ?? recoveryEmail.trim();
    if (!lookupEmail || !recoveryOtp.trim()) {
      setRecoveryError('Enter the recovery email and the code that was sent to it.');
      return;
    }

    setRecoveryPendingAction('verify-email');
    setRecoveryError(null);
    try {
      const result = await verifyAccountRecoveryEmail(lookupEmail, recoveryOtp.trim());
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
  }, [recoveryEmail, recoveryLookupEmail, recoveryOtp]);

  const handleVerifyBackupCode = useCallback(async () => {
    const lookupEmail = recoveryLookupEmail ?? recoveryEmail.trim();
    if (!lookupEmail || !recoveryBackupCode.trim()) {
      setRecoveryError('Enter the account email and one backup code.');
      return;
    }

    setRecoveryPendingAction('verify-backup-code');
    setRecoveryError(null);
    try {
      const result = await verifyAccountRecoveryBackupCode(lookupEmail, recoveryBackupCode.trim());
      setRecoveryPasskeyContext(result.recoveryPasskeyContext);
      setRecoveryStep('enroll');
      setRecoveryMessage('Backup code accepted. Add a new passkey to finish restoring access.');
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : 'That backup code was not valid.');
    } finally {
      setRecoveryPendingAction(null);
    }
  }, [recoveryBackupCode, recoveryEmail, recoveryLookupEmail]);

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
                {CREATOR_SUITE_SIGN_IN_METHODS.map((method) => (
                  <button
                    key={method.id}
                    id={method.id === 'discord' ? 'retry-btn' : undefined}
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
