import { createFileRoute, useSearch } from '@tanstack/react-router';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import '@/styles/vrchat-verify.css';

const SLIDE_IMAGES = [
  'https://dtuitjyhwcl5y.cloudfront.net/960324bdaa4dd770-1920w.jpg',
  'https://dtuitjyhwcl5y.cloudfront.net/0848895a9717ee5a-1920w.jpg',
  'https://dtuitjyhwcl5y.cloudfront.net/a15004cb78587aea-1980w.jpg',
  'https://dtuitjyhwcl5y.cloudfront.net/5ac33cecd162656c-1980w.jpg',
];

const WORLD_NAMES = ['The Great Pug', 'Midnight Rooftop', 'Silent Horizon', 'Sky Lounge'];

const SLIDE_DURATION = 24;

const PENDING_TYPES_KEY = 'vrchat_pending_types';
const PENDING_STEP_KEY = 'vrchat_pending_step';

type ViewState = 'no-token' | 'form' | 'two-factor' | 'success';

export const Route = createFileRoute('/setup/vrchat')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: (search.token as string) || '',
    mode: (search.mode as string) || '',
    guild_id: (search.guild_id as string) || '',
    tenant_id: (search.tenant_id as string) || '',
  }),
  head: () => ({
    meta: [{ title: 'Verify with VRChat | Creator Assistant' }],
  }),
  component: VRChatVerifyPage,
});

function VRChatVerifyPage() {
  const { token, mode, guild_id, tenant_id } = useSearch({ from: '/setup/vrchat' });
  const isConnectMode = mode === 'connect';

  const [viewState, setViewState] = useState<ViewState>('form');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [pendingTypes, setPendingTypes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [slideStartIndex, setSlideStartIndex] = useState(0);

  const errorRef = useRef<HTMLParagraphElement>(null);
  const successRef = useRef<HTMLParagraphElement>(null);
  const twoFactorRef = useRef<HTMLInputElement>(null);
  const liveRegionsEnabled = useRef(false);

  const getSessionEndpoint = useCallback(() => {
    return isConnectMode ? '/api/connect/vrchat/session' : '/api/verification/vrchat-verify';
  }, [isConnectMode]);
  const allowsTokenlessConnect = isConnectMode;

  const enableLiveRegions = useCallback(() => {
    if (liveRegionsEnabled.current) return;
    liveRegionsEnabled.current = true;
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const showSuccess = useCallback(() => {
    sessionStorage.removeItem(PENDING_STEP_KEY);
    sessionStorage.removeItem(PENDING_TYPES_KEY);

    if (isConnectMode) {
      const dashboardUrl = new URL('/dashboard', window.location.origin);
      dashboardUrl.searchParams.set('vrchat', 'connected');
      if (guild_id) dashboardUrl.searchParams.set('guild_id', guild_id);
      if (tenant_id) dashboardUrl.searchParams.set('tenant_id', tenant_id);
      window.location.href = dashboardUrl.toString();
      return;
    }

    setViewState('success');
    setTimeout(() => window.close(), 1500);
  }, [isConnectMode, guild_id, tenant_id]);

  const showCredentialStep = useCallback(() => {
    setPendingTypes([]);
    sessionStorage.removeItem(PENDING_STEP_KEY);
    sessionStorage.removeItem(PENDING_TYPES_KEY);
    setTwoFactorCode('');
    setViewState('form');
  }, []);

  const showTwoFactorStep = useCallback((types: string[]) => {
    const safeTypes = Array.isArray(types) ? types : [];
    setPendingTypes(safeTypes);
    sessionStorage.setItem(PENDING_STEP_KEY, 'true');
    sessionStorage.setItem(PENDING_TYPES_KEY, JSON.stringify(safeTypes));
    setViewState('two-factor');
  }, []);

  const restorePendingStep = useCallback(() => {
    const pendingStep = sessionStorage.getItem(PENDING_STEP_KEY) === 'true';
    if (!pendingStep) {
      showCredentialStep();
      return;
    }

    let types: string[] = [];
    try {
      types = JSON.parse(sessionStorage.getItem(PENDING_TYPES_KEY) || '[]');
    } catch {
      types = [];
    }
    showTwoFactorStep(types);
  }, [showCredentialStep, showTwoFactorStep]);

  // Randomize slideshow start index
  useEffect(() => {
    const startIndex = Math.floor(Math.random() * 4);
    setSlideStartIndex(startIndex);
  }, []);

  // Show no-token view when token is missing
  useEffect(() => {
    if (!token) {
      setViewState(allowsTokenlessConnect ? 'form' : 'no-token');
    }
  }, [token, allowsTokenlessConnect]);

  // Auto-verify on mount (verify mode only)
  useEffect(() => {
    if (!token || isConnectMode) return;

    restorePendingStep();
    setIsSubmitting(true);

    fetch(getSessionEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          showSuccess();
        } else if (data.needsCredentials || data.sessionExpired) {
          if (data.sessionExpired) {
            setError('Your previous VRChat session has expired. Please sign in again.');
          }
          restorePendingStep();
          setIsSubmitting(false);
        } else {
          setError(data.error || 'Auto-verify failed. Please enter your credentials.');
          showCredentialStep();
          setIsSubmitting(false);
        }
      })
      .catch(() => {
        showCredentialStep();
        setIsSubmitting(false);
      });
  }, [
    token,
    isConnectMode,
    getSessionEndpoint,
    restorePendingStep,
    showSuccess,
    showCredentialStep,
  ]);

  // Focus 2FA input when entering that step
  useEffect(() => {
    if (viewState === 'two-factor') {
      twoFactorRef.current?.focus();
    }
  }, [viewState]);

  // Focus success message when shown
  useEffect(() => {
    if (viewState === 'success') {
      successRef.current?.focus({ preventScroll: true });
    }
  }, [viewState]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['Tab', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        enableLiveRegions();
      }
      if (e.key === 'Escape' && error) {
        clearError();
        return;
      }
      if (
        ['ArrowUp', 'ArrowDown'].includes(e.key) &&
        (viewState === 'form' || viewState === 'two-factor')
      ) {
        const focusable = Array.from(
          document.querySelectorAll<HTMLElement>('#vrchat-form input, #vrchat-form button')
        ).filter((el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled);

        const i = focusable.indexOf(document.activeElement as HTMLElement);
        if (i === -1) return;
        const next =
          e.key === 'ArrowDown'
            ? (i + 1) % focusable.length
            : (i - 1 + focusable.length) % focusable.length;
        focusable[next].focus();
        e.preventDefault();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [error, viewState, enableLiveRegions, clearError]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();

    if (!token && !allowsTokenlessConnect) {
      setError(
        isConnectMode
          ? 'Invalid or expired link. Please use the Connect VRChat button in the dashboard.'
          : 'Invalid or expired link. Please use the Verify with VRChat button in Discord.'
      );
      return;
    }

    const requestBody: Record<string, string> = {};
    if (token) {
      requestBody.token = token;
    }

    if (viewState === 'two-factor') {
      if (!twoFactorCode.trim()) {
        setError('Please enter your 2FA code.');
        return;
      }
      requestBody.twoFactorCode = twoFactorCode.trim();
      if (pendingTypes.length === 1) {
        requestBody.type = pendingTypes[0];
      }
    } else {
      if (!username.trim() || !password) {
        setError('Please enter your VRChat username and password.');
        return;
      }
      requestBody.username = username.trim();
      requestBody.password = password;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch(getSessionEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(requestBody),
      });
      const data = await res.json();

      if (data.success) {
        showSuccess();
      } else if (data.twoFactorRequired) {
        clearError();
        showTwoFactorStep(data.types);
      } else {
        if (data.needsCredentials || data.sessionExpired) {
          showCredentialStep();
        }
        setError(data.error || 'Verification failed. Please check your credentials.');
      }
    } catch {
      setError('Network error. Please try again.');
    }

    setIsSubmitting(false);
  };

  const is2FA = viewState === 'two-factor';
  const submitLabel = is2FA ? 'Verify' : 'Continue';
  const submittingLabel = is2FA ? 'Verifying...' : 'Continuing...';
  const autoChecking = isSubmitting && viewState !== 'two-factor' && viewState !== 'success';

  const title = isConnectMode ? 'Connect your VRChat\u00AE account' : 'Sign in with VRChat\u00AE';
  const subtitle = isConnectMode
    ? 'Sign in to connect your VRChat\u00AE store to Creator Assistant'
    : 'Verify your avatar ownership to unlock your roles';
  const mainAriaLabel = isConnectMode ? 'VRChat account connect' : 'VRChat verification';
  const noTokenContent = isConnectMode ? (
    <p>
      This page requires a valid connection link. Please use the <strong>Add VRChat Account</strong>{' '}
      button in the Creator Assistant dashboard to get started.
    </p>
  ) : (
    <p>
      This page requires a valid verification link. Please use the{' '}
      <strong>Verify with VRChat&reg;</strong> button in Discord&reg; to get started.
    </p>
  );

  const disclaimerLong = isConnectMode ? (
    <>
      <strong>Your sign-in is used to connect your VRChat&reg; store to Creator Assistant.</strong>{' '}
      We send your credentials directly to VRChat&reg; and never save your password or 2FA code. We
      keep an encrypted session (like a &ldquo;remember me&rdquo; token) to sync your store listings
      until VRChat&reg; expires it.
    </>
  ) : (
    <>
      <strong>Your sign-in is used only to verify your VRChat&reg; Marketplace purchases.</strong>{' '}
      We send your credentials directly to VRChat&reg; and never save your password or 2FA code. To
      avoid asking you to sign in again, we keep an encrypted session (like a &ldquo;remember
      me&rdquo; token) until VRChat&reg; expires it.
    </>
  );

  const disclaimerShort = isConnectMode ? (
    <>
      <strong>Sign-in connects your VRChat&reg; store to Creator Assistant.</strong> We never save
      your password or 2FA code.
    </>
  ) : (
    <>
      <strong>Sign-in verifies your VRChat&reg; Marketplace purchases.</strong> We never save your
      password or 2FA code.
    </>
  );

  function getSlideDelay(i: number): string {
    return `${((i - slideStartIndex + 4) % 4) * SLIDE_DURATION}s`;
  }

  return (
    <div className="vrchat-verify">
      {/* Background slideshow */}
      <div className="bg-slideshow" aria-hidden="true">
        {SLIDE_IMAGES.map((url, i) => (
          <div
            key={url}
            className={`bg-slide${i === slideStartIndex ? ' bg-slide-start' : ''}`}
            style={{
              backgroundImage: `url('${url}')`,
              animationDelay: getSlideDelay(i),
            }}
          />
        ))}
      </div>
      <div className="bg-overlay" aria-hidden="true" />

      {/* Bottom bar with world names + corner logo */}
      <div className="bottom-bar">
        <div className="world-name-container">
          {WORLD_NAMES.map((name, i) => (
            <span
              key={name}
              className="world-name"
              aria-hidden="true"
              style={{ animationDelay: getSlideDelay(i) }}
            >
              {name}
            </span>
          ))}
        </div>
        <div className="logo-corner" aria-hidden="true">
          <img src="/Icons/MainLogo.png" alt="" />
        </div>
      </div>

      {/* Main logo */}
      <div className="logo">
        <img src="/Icons/MainLogo.png" alt="Creator Assistant" />
      </div>

      {/* Card */}
      <main className="vrchat-card" aria-label={mainAriaLabel}>
        {/* No-token view */}
        {viewState === 'no-token' && (
          <div className="no-token" aria-hidden="false">
            {noTokenContent}
          </div>
        )}

        {/* Form / 2FA / Success views */}
        {viewState !== 'no-token' && (
          <div>
            <h1>
              <img src="/Icons/VRC.png" alt="" className="vrchat-heading-icon" aria-hidden="true" />
              {title}
            </h1>
            <p className="subtitle">{subtitle}</p>

            <div className="disclaimer">
              <span className="disclaimer-long">{disclaimerLong}</span>
              <span className="disclaimer-short">{disclaimerShort}</span>
            </div>

            {viewState !== 'success' && (
              <form
                id="vrchat-form"
                aria-labelledby="form-heading"
                aria-describedby="error-msg"
                noValidate
                onSubmit={handleSubmit}
              >
                {/* Username */}
                <div
                  className="form-group"
                  style={{ display: is2FA ? 'none' : undefined }}
                  aria-hidden={is2FA}
                >
                  <label htmlFor="username">VRChat&reg; Username</label>
                  <input
                    type="text"
                    id="username"
                    name="username"
                    required
                    placeholder="Your VRChat® username"
                    autoComplete="username"
                    aria-invalid={!is2FA && !!error}
                    aria-describedby="error-msg"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>

                {/* Password */}
                <div
                  className="form-group"
                  style={{ display: is2FA ? 'none' : undefined }}
                  aria-hidden={is2FA}
                >
                  <label htmlFor="password">VRChat&reg; Password</label>
                  <input
                    type="password"
                    id="password"
                    name="password"
                    required
                    placeholder="Your VRChat® password"
                    autoComplete="current-password"
                    aria-invalid={!is2FA && !!error}
                    aria-describedby="error-msg"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                {/* 2FA */}
                <div
                  className="form-group"
                  style={{ display: is2FA ? undefined : 'none' }}
                  aria-hidden={!is2FA}
                >
                  <label htmlFor="twoFactorCode">2FA Code</label>
                  <input
                    ref={twoFactorRef}
                    type="text"
                    id="twoFactorCode"
                    name="twoFactorCode"
                    placeholder="Enter your authenticator, email, or recovery code"
                    autoComplete="one-time-code"
                    aria-invalid={is2FA && !!error}
                    aria-describedby="error-msg"
                    value={twoFactorCode}
                    onChange={(e) => setTwoFactorCode(e.target.value)}
                  />
                </div>

                {/* Error */}
                <p
                  ref={errorRef}
                  id="error-msg"
                  className={`error-msg${error ? ' visible' : ''}`}
                  role={liveRegionsEnabled.current ? 'alert' : undefined}
                  aria-live={liveRegionsEnabled.current ? 'assertive' : undefined}
                  aria-atomic={liveRegionsEnabled.current ? 'true' : undefined}
                >
                  {error}
                </p>

                {/* Submit */}
                <button
                  type="submit"
                  className="btn-verify"
                  disabled={isSubmitting}
                  aria-busy={isSubmitting}
                  aria-label={isSubmitting ? submittingLabel : submitLabel}
                >
                  {isSubmitting ? (autoChecking ? 'Checking\u2026' : submittingLabel) : submitLabel}
                </button>
              </form>
            )}

            {/* Success */}
            {viewState === 'success' && (
              <p
                ref={successRef}
                className="success-msg"
                role={liveRegionsEnabled.current ? 'status' : undefined}
                aria-live={liveRegionsEnabled.current ? 'polite' : undefined}
                tabIndex={-1}
              >
                Verification successful! You can close this window and return to Discord&reg;.
              </p>
            )}

            <p
              className="trademark"
              style={{
                fontSize: '11px',
                textAlign: 'center',
                color: 'rgba(255,255,255,0.4)',
                marginTop: '1.5rem',
              }}
            >
              VRChat&reg; is a trademark of VRChat Inc. Creator Assistant is not affiliated with,
              endorsed by, or sponsored by VRChat Inc.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
