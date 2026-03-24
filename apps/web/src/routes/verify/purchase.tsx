import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
  getUserVerificationIntent,
  type UserVerificationIntent,
  type UserVerificationIntentRequirement,
  verifyUserVerificationEntitlement,
  verifyUserVerificationManualLicense,
  verifyUserVerificationProviderLink,
} from '@/lib/account';
import {
  getProviderIconPath,
  listUserAccounts,
  listUserProviders,
  startUserVerify,
  type UserAccountConnection,
  type UserProvider,
} from '@/lib/dashboard';
import {
  getPurchaseIntentLoadErrorState,
  getVisiblePurchaseVerificationError,
  shouldAutoCheckExistingEntitlement,
} from './-purchaseUiState';
import '@/styles/verify-purchase.css';

export const Route = createFileRoute('/verify/purchase')({
  validateSearch: (search: Record<string, unknown>) => ({
    intent: typeof search.intent === 'string' ? search.intent : '',
    connected: typeof search.connected === 'string' ? search.connected : undefined,
  }),
  head: () => ({
    meta: [{ title: 'Verify Purchase | YUCP' }],
  }),
  beforeLoad: ({ context, location }) => {
    if (!context.isAuthenticated) {
      throw redirect({
        to: '/sign-in',
        search: { redirectTo: location.href },
      });
    }
  },
  component: VerifyPurchasePage,
});

function getSafeReturnUrl(value: string | null | undefined): string | null {
  if (!value || typeof window === 'undefined') return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol === 'https:') return url.toString();
    const isLoopback =
      url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return isLoopback ? url.toString() : null;
  } catch {
    return null;
  }
}

function buildReturnUrl(intent: UserVerificationIntent): string | null {
  const base = getSafeReturnUrl(intent.returnUrl);
  if (!base || !intent.grantToken) return base;
  const url = new URL(base);
  url.searchParams.set('intent_id', intent.id);
  url.searchParams.set('grant', intent.grantToken);
  return url.toString();
}

// ---- Branded OAuth button -------------------------------------------------

interface OAuthButtonProps {
  intentId: string;
  requirement: UserVerificationIntentRequirement;
  linkedAccounts: UserAccountConnection[];
  provider: UserProvider | null;
  providersLoading: boolean;
  verifiedMethodKey: string | null;
  onSuccess: () => void;
}

function OAuthMethodButton({
  intentId,
  requirement,
  linkedAccounts,
  provider,
  providersLoading,
  verifiedMethodKey,
  onSuccess,
}: OAuthButtonProps) {
  const queryClient = useQueryClient();

  const isVerified = verifiedMethodKey === requirement.methodKey;
  const activeLink = linkedAccounts.find((a) => a.status === 'active') ?? null;
  const expiredLink = !activeLink
    ? (linkedAccounts.find((a) => a.status === 'expired') ?? null)
    : null;
  const isConnected = activeLink !== null;
  const linkedLabel = activeLink?.providerUsername ?? activeLink?.providerUserId ?? null;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['vp-intent', intentId] });
    onSuccess();
  };

  const providerLinkMut = useMutation({
    mutationFn: () => verifyUserVerificationProviderLink(intentId, requirement.methodKey),
    onSuccess: invalidate,
  });

  const connectMut = useMutation({
    mutationFn: async () => {
      const returnUrl = `/verify/purchase?intent=${encodeURIComponent(intentId)}&connected=${encodeURIComponent(requirement.providerKey)}`;
      return startUserVerify(requirement.providerKey, returnUrl);
    },
    onSuccess: ({ redirectUrl }) => {
      window.location.href = redirectUrl;
    },
  });

  const iconSrc = provider ? getProviderIconPath(provider) : null;
  const brandColor = provider?.color ?? null;

  // Verified state — green row
  if (isVerified) {
    return (
      <div className="vp-oauth-row vp-oauth-row--verified">
        <div className="vp-oauth-row-left">
          {iconSrc ? (
            <img src={iconSrc} alt="" className="vp-oauth-icon" aria-hidden="true" />
          ) : null}
          <div className="vp-oauth-row-text">
            <span className="vp-oauth-label">{requirement.providerLabel}</span>
            {linkedLabel ? <span className="vp-oauth-account">@{linkedLabel}</span> : null}
          </div>
        </div>
        <span className="vp-status-badge vp-status-badge--connected">
          <svg viewBox="0 0 16 16" aria-hidden="true" className="vp-status-badge-icon">
            <polyline points="3 8 6 11 13 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Verified
        </span>
      </div>
    );
  }

  // Connected — show account info + Verify button
  if (isConnected) {
    return (
      <div className="vp-oauth-row">
        <div className="vp-oauth-row-left">
          {iconSrc ? (
            <img src={iconSrc} alt="" className="vp-oauth-icon" aria-hidden="true" />
          ) : null}
          <div className="vp-oauth-row-text">
            <span className="vp-oauth-label">{requirement.providerLabel}</span>
            {linkedLabel ? <span className="vp-oauth-account">@{linkedLabel}</span> : null}
          </div>
        </div>
        <div className="vp-oauth-row-right">
          <button
            type="button"
            className={`vp-oauth-verify-btn${providerLinkMut.isPending ? ' btn-loading' : ''}`}
            onClick={() => providerLinkMut.mutate()}
            disabled={providerLinkMut.isPending}
            style={brandColor ? ({ '--brand': brandColor } as React.CSSProperties) : undefined}
          >
            {providerLinkMut.isPending ? (
              <>
                <span className="btn-loading-spinner" aria-hidden="true" />
                Verifying...
              </>
            ) : (
              `Verify purchase`
            )}
          </button>
        </div>
        {providerLinkMut.isError ? (
          <p className="vp-method-error vp-method-error--full">
            Uh oh, we didn't find a purchase. Make sure you bought on this account.
          </p>
        ) : null}
      </div>
    );
  }

  // Loading state (providers query hasn't resolved yet)
  if (providersLoading && !provider) {
    return <div className="vp-oauth-btn-skeleton" aria-hidden="true" />;
  }

  // Not connected — show branded Sign in button
  const isPending = connectMut.isPending;
  const buttonLabel = expiredLink
    ? `Reconnect ${requirement.providerLabel}`
    : `Sign in with ${requirement.providerLabel}`;

  return (
    <div className="vp-oauth-signin-wrap">
      <button
        type="button"
        className={`vp-oauth-signin-btn${isPending ? ' btn-loading' : ''}`}
        onClick={() => connectMut.mutate()}
        disabled={isPending}
        style={
          brandColor
            ? ({
                '--brand': brandColor,
                '--brand-dark': brandColor,
              } as React.CSSProperties)
            : undefined
        }
      >
        {isPending ? (
          <>
            <span className="btn-loading-spinner vp-oauth-signin-spinner" aria-hidden="true" />
            <span>{expiredLink ? 'Reconnecting...' : 'Connecting...'}</span>
          </>
        ) : (
          <>
            {iconSrc ? (
              <img src={iconSrc} alt="" className="vp-oauth-signin-icon" aria-hidden="true" />
            ) : null}
            <span>{buttonLabel}</span>
          </>
        )}
      </button>
      {connectMut.isError ? (
        <p className="vp-method-error" style={{ textAlign: 'center', marginTop: '0.4rem' }}>
          Could not connect — please try again
        </p>
      ) : null}
    </div>
  );
}

// ---- License key method ---------------------------------------------------

interface LicenseRowProps {
  intentId: string;
  requirement: UserVerificationIntentRequirement;
  provider: UserProvider | null;
  verifiedMethodKey: string | null;
  onSuccess: () => void;
}

function LicenseMethodRow({
  intentId,
  requirement,
  provider,
  verifiedMethodKey,
  onSuccess,
}: LicenseRowProps) {
  const [licenseKey, setLicenseKey] = useState('');
  const queryClient = useQueryClient();

  const isVerified = verifiedMethodKey === requirement.methodKey;
  const iconSrc = provider ? getProviderIconPath(provider) : null;

  const licenseMut = useMutation({
    mutationFn: () =>
      verifyUserVerificationManualLicense(intentId, requirement.methodKey, licenseKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vp-intent', intentId] });
      onSuccess();
    },
  });

  const cap = requirement.capability;

  return (
    <div className={`vp-method-row${isVerified ? ' vp-method-row--verified' : ''}`}>
      <div className="vp-method-row-info">
        <div className="vp-method-provider">
          {iconSrc ? (
            <img src={iconSrc} alt="" className="vp-provider-icon" aria-hidden="true" />
          ) : null}
          <span className="vp-provider-label-text">{requirement.providerLabel}</span>
        </div>
        <p className="vp-method-title">{requirement.title}</p>
        {requirement.description ? (
          <p className="vp-method-desc">{requirement.description}</p>
        ) : null}
      </div>

      <div className="vp-method-row-action vp-method-row-action--license">
        {isVerified ? (
          <span className="vp-status-badge vp-status-badge--connected">Verified</span>
        ) : (
          <>
            <input
              type={cap.input?.masked === false ? 'text' : 'password'}
              className="vp-license-input"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && licenseKey.trim()) licenseMut.mutate();
              }}
              placeholder={cap.input?.placeholder ?? 'Enter license key'}
              aria-label={cap.input?.label ?? 'License key'}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className={`vp-action-btn${licenseMut.isPending ? ' btn-loading' : ''}`}
              onClick={() => licenseMut.mutate()}
              disabled={licenseMut.isPending || licenseKey.trim().length === 0}
            >
              {licenseMut.isPending ? (
                <>
                  <span className="btn-loading-spinner" aria-hidden="true" />
                  Verifying...
                </>
              ) : (
                (cap.input?.submitLabel ?? cap.actionLabel)
              )}
            </button>
            {licenseMut.isError ? (
              <p className="vp-method-error">License key not found or already used</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// ---- Entitlement check (silent) -------------------------------------------

interface EntitlementRowProps {
  intentId: string;
  requirement: UserVerificationIntentRequirement;
  provider: UserProvider | null;
  verifiedMethodKey: string | null;
  isAutoChecking: boolean;
  onSuccess: () => void;
}

function EntitlementRow({
  intentId,
  requirement,
  provider,
  verifiedMethodKey,
  isAutoChecking,
  onSuccess,
}: EntitlementRowProps) {
  const queryClient = useQueryClient();
  const isVerified = verifiedMethodKey === requirement.methodKey;
  const iconSrc = provider ? getProviderIconPath(provider) : null;

  const entitlementMut = useMutation({
    mutationFn: () => verifyUserVerificationEntitlement(intentId, requirement.methodKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vp-intent', intentId] });
      onSuccess();
    },
  });

  return (
    <div className={`vp-method-row${isVerified ? ' vp-method-row--verified' : ''}`}>
      <div className="vp-method-row-info">
        <div className="vp-method-provider">
          {iconSrc ? (
            <img src={iconSrc} alt="" className="vp-provider-icon" aria-hidden="true" />
          ) : null}
          <span className="vp-provider-label-text">{requirement.providerLabel}</span>
        </div>
        <p className="vp-method-title">{requirement.title}</p>
        {requirement.description ? (
          <p className="vp-method-desc">{requirement.description}</p>
        ) : null}
      </div>

      <div className="vp-method-row-action">
        {isVerified ? (
          <span className="vp-status-badge vp-status-badge--connected">Verified</span>
        ) : isAutoChecking || entitlementMut.isPending ? (
          <span className="vp-checking-text">
            <span className="vp-spinner" aria-hidden="true" />
            Checking...
          </span>
        ) : entitlementMut.isError ? (
          <button type="button" className="vp-action-btn" onClick={() => entitlementMut.mutate()}>
            Try again
          </button>
        ) : (
          <button
            type="button"
            className="vp-action-btn"
            onClick={() => entitlementMut.mutate()}
            disabled={entitlementMut.isPending}
          >
            {requirement.capability.actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

// ---- page component -----------------------------------------------

function VerifyPurchasePage() {
  const { intent: intentId, connected: justConnectedProvider } = useSearch({
    from: '/verify/purchase',
  });

  const [isVisible, setIsVisible] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [redirectCountdown, setRedirectCountdown] = useState(5);
  const [successHandled, setSuccessHandled] = useState(false);

  const [entitlementCheckState, setEntitlementCheckState] = useState<'idle' | 'checking' | 'done'>(
    'idle'
  );
  const [oauthReturnState, setOauthReturnState] = useState<'idle' | 'checking' | 'done'>('idle');

  const queryClient = useQueryClient();
  const { signOut } = useAuth();

  useEffect(() => {
    setIsVisible(true);
  }, []);

  const intentQuery = useQuery({
    queryKey: ['vp-intent', intentId],
    queryFn: () => getUserVerificationIntent(intentId),
    enabled: intentId.length > 0,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status === 'pending' ? 3000 : false;
    },
  });

  const intent = intentQuery.data;
  const shouldAutoCheckEntitlement = useMemo(
    () => shouldAutoCheckExistingEntitlement(intent?.requirements ?? []),
    [intent]
  );

  const providersQuery = useQuery({
    queryKey: ['vp-providers'],
    queryFn: listUserProviders,
    enabled: intent != null,
    staleTime: 60_000,
  });

  const accountsQuery = useQuery({
    queryKey: ['vp-accounts'],
    queryFn: listUserAccounts,
    enabled: intent != null,
    staleTime: 30_000,
  });

  // Auto-check existing_entitlement on first load
  useEffect(() => {
    if (entitlementCheckState !== 'idle') return;
    if (!intent || intent.status !== 'pending') return;
    if (!shouldAutoCheckEntitlement) {
      setEntitlementCheckState('done');
      return;
    }

    const method = intent.requirements.find((r) => r.kind === 'existing_entitlement');
    if (!method) {
      setEntitlementCheckState('done');
      return;
    }

    setEntitlementCheckState('checking');
    verifyUserVerificationEntitlement(intentId, method.methodKey)
      .then(() => queryClient.invalidateQueries({ queryKey: ['vp-intent', intentId] }))
      .catch(() => {})
      .finally(() => setEntitlementCheckState('done'));
  }, [intent, intentId, entitlementCheckState, queryClient, shouldAutoCheckEntitlement]);

  // Auto-verify provider link after OAuth return
  useEffect(() => {
    if (oauthReturnState !== 'idle') return;
    if (!justConnectedProvider || !intent || intent.status !== 'pending') return;

    const method = intent.requirements.find(
      (r) => r.kind === 'buyer_provider_link' && r.providerKey === justConnectedProvider
    );

    if (!method) {
      setOauthReturnState('done');
      return;
    }

    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('connected');
      window.history.replaceState({}, '', url.toString());
    }

    setOauthReturnState('checking');
    verifyUserVerificationProviderLink(intentId, method.methodKey)
      .then(() => queryClient.invalidateQueries({ queryKey: ['vp-intent', intentId] }))
      .catch(() => {})
      .finally(() => setOauthReturnState('done'));
  }, [intent, intentId, justConnectedProvider, oauthReturnState, queryClient]);

  const returnToUrl = useMemo(() => (intent ? buildReturnUrl(intent) : null), [intent]);

  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!intent || intent.status !== 'verified' || successHandled || !returnToUrl) return;
    setSuccessHandled(true);
    setRedirectCountdown(5);

    countdownRef.current = setInterval(() => {
      setRedirectCountdown((c) => {
        if (c <= 1) {
          if (countdownRef.current) clearInterval(countdownRef.current);
          window.location.href = returnToUrl;
          return 0;
        }
        return c - 1;
      });
    }, 1000);

    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [intent, returnToUrl, successHandled]);

  const providersByKey = useMemo(
    () => new Map((providersQuery.data ?? []).map((p) => [p.id, p])),
    [providersQuery.data]
  );

  const accountsByProvider = useMemo(() => {
    const m = new Map<string, UserAccountConnection[]>();
    for (const acc of accountsQuery.data ?? []) {
      const list = m.get(acc.provider) ?? [];
      list.push(acc);
      m.set(acc.provider, list);
    }
    return m;
  }, [accountsQuery.data]);

  const hasEntitlementMethod =
    intent?.requirements.some((r) => r.kind === 'existing_entitlement') ?? false;

  const isAutoChecking =
    (hasEntitlementMethod && entitlementCheckState === 'checking') ||
    oauthReturnState === 'checking';

  const wrapperClass = `vp-wrapper`;
  const mainClass = `vp-main${isVisible ? ' is-visible' : ''}`;

  // ---- empty intent
  if (!intentId) {
    return (
      <div className={wrapperClass}>
        <main className={mainClass}>
          <div className="vp-card vp-card--error fade-up" style={{ animationDelay: '0.15s' }}>
            <h1 className="vp-package-name">No verification intent</h1>
            <p className="vp-card-subtitle">
              This page must be opened from within Unity's verification flow. Return to Unity and
              try again.
            </p>
          </div>
        </main>
      </div>
    );
  }

  // ---- loading
  if (intentQuery.isPending) {
    return (
      <div className={wrapperClass}>
        <main className={mainClass}>
          <div className="vp-card fade-up" style={{ animationDelay: '0.1s' }}>
            <div className="vp-loading-state">
              <span className="vp-spinner vp-spinner--lg" aria-hidden="true" />
              <p className="vp-loading-text">Loading verification...</p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // ---- fetch error
  if (intentQuery.isError || !intent) {
    const loadErrorState = getPurchaseIntentLoadErrorState(intentQuery.error);
    return (
      <div className={wrapperClass}>
        <main className={mainClass}>
          <div className="vp-card vp-card--error fade-up" style={{ animationDelay: '0.1s' }}>
            <h1 className="vp-package-name">{loadErrorState.title}</h1>
            <p className="vp-card-subtitle">{loadErrorState.message}</p>
            {loadErrorState.allowSignOut ? (
              <button
                type="button"
                className={`vp-primary-btn${isSigningOut ? ' btn-loading' : ''}`}
                onClick={async () => {
                  setIsSigningOut(true);
                  try {
                    await signOut();
                  } finally {
                    setIsSigningOut(false);
                  }
                }}
                disabled={isSigningOut}
              >
                {isSigningOut ? (
                  <>
                    <span className="btn-loading-spinner" aria-hidden="true" />
                    Signing out...
                  </>
                ) : (
                  'Sign out and continue'
                )}
              </button>
            ) : null}
          </div>
        </main>
      </div>
    );
  }

  // ---- expired / cancelled
  if (intent.status === 'expired' || intent.status === 'cancelled') {
    return (
      <div className={wrapperClass}>
        <main className={mainClass}>
          <div className="vp-card vp-card--error fade-up" style={{ animationDelay: '0.1s' }}>
            <h1 className="vp-package-name">Verification expired</h1>
            <p className="vp-card-subtitle">
              This verification session has expired. Return to Unity and start the flow again.
            </p>
          </div>
        </main>
      </div>
    );
  }

  // ---- verified (success)
  if (intent.status === 'verified') {
    return (
      <div className={wrapperClass}>
        <main className={mainClass}>
          <div className="vp-card vp-card--success" style={{ textAlign: 'center' }}>
            <div className="vp-success-icon fade-up" style={{ animationDelay: '0.1s' }}>
              <svg viewBox="0 0 100 100" aria-hidden="true">
                <circle
                  className="vp-circle-path"
                  cx="50"
                  cy="50"
                  r="45"
                  stroke="var(--accent-green-dark)"
                  strokeWidth="5"
                  fill="none"
                />
                <path
                  className="vp-check-path"
                  d="M28 50 L43 65 L72 35"
                  stroke="var(--accent-green-dark)"
                  strokeWidth="5"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>

            <h1 className="vp-success-title fade-up" style={{ animationDelay: '0.3s' }}>
              Verified!
            </h1>

            <p className="vp-success-subtitle fade-up" style={{ animationDelay: '0.45s' }}>
              {intent.packageName || intent.packageId} — purchase confirmed. Return to Unity to
              finish installing.
            </p>

            {returnToUrl ? (
              <div className="fade-up" style={{ animationDelay: '0.6s' }}>
                <a href={returnToUrl} className="vp-primary-btn">
                  Return to Unity
                </a>
                <p className="vp-countdown-text">Returning automatically in {redirectCountdown}s</p>
              </div>
            ) : (
              <p
                className="vp-success-subtitle fade-up"
                style={{ animationDelay: '0.6s', marginBottom: '2rem' }}
              >
                You can close this window and return to Unity.
              </p>
            )}
          </div>
        </main>
      </div>
    );
  }

  // ---- pending: main verification panel
  const oauthMethods = intent.requirements.filter((r) => r.kind === 'buyer_provider_link');
  const licenseMethods = intent.requirements.filter((r) => r.kind === 'manual_license');
  const entitlementMethods = intent.requirements.filter((r) => r.kind === 'existing_entitlement');
  const verifiedMethodKey = intent.verifiedMethodKey ?? null;

  const hasOAuth = oauthMethods.length > 0;
  const hasLicense = licenseMethods.length > 0;
  const hasEntitlement = entitlementMethods.length > 0;
  const visibleErrorMessage = getVisiblePurchaseVerificationError({
    errorCode: intent.errorCode,
    errorMessage: intent.errorMessage,
    requirements: intent.requirements,
  });

  const invalidateIntent = () =>
    queryClient.invalidateQueries({ queryKey: ['vp-intent', intentId] });

  return (
    <div className={wrapperClass}>
      <main className={mainClass}>
        <div className="vp-card fade-up" style={{ animationDelay: '0.1s' }}>
          {/* Header */}
          <div className="vp-card-header">
            <p className="vp-eyebrow">Verify your purchase</p>
            <h1 className="vp-package-name">{intent.packageName || intent.packageId}</h1>
            {visibleErrorMessage ? (
              <div className="vp-error-banner">{visibleErrorMessage}</div>
            ) : null}
          </div>

          {isAutoChecking ? (
            <div className="vp-checking-section">
              <span className="vp-spinner vp-spinner--lg" aria-hidden="true" />
              <p className="vp-checking-text">Checking your access...</p>
            </div>
          ) : (
            <>
              {/* OAuth sign-in section */}
              {hasOAuth ? (
                <div className="vp-oauth-section">
                  <p className="vp-section-eyebrow">Sign in to verify</p>
                  <p className="vp-section-desc">
                    Choose the store where you purchased this product.
                  </p>
                  <div className="vp-oauth-buttons">
                    {oauthMethods.map((req) => (
                      <OAuthMethodButton
                        key={req.methodKey}
                        intentId={intentId}
                        requirement={req}
                        linkedAccounts={accountsByProvider.get(req.providerKey) ?? []}
                        provider={providersByKey.get(req.providerKey) ?? null}
                        providersLoading={providersQuery.isPending}
                        verifiedMethodKey={verifiedMethodKey}
                        onSuccess={invalidateIntent}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Divider between OAuth and license */}
              {hasOAuth && hasLicense ? (
                <div className="vp-methods-divider">
                  <span className="vp-methods-divider-label">or enter license key</span>
                </div>
              ) : null}

              {/* License key section */}
              {hasLicense ? (
                <div className={`vp-section${!hasOAuth ? ' vp-section--top' : ''}`}>
                  {!hasOAuth ? <p className="vp-section-title">Enter license key</p> : null}
                  {licenseMethods.map((req) => (
                    <LicenseMethodRow
                      key={req.methodKey}
                      intentId={intentId}
                      requirement={req}
                      provider={providersByKey.get(req.providerKey) ?? null}
                      verifiedMethodKey={verifiedMethodKey}
                      onSuccess={invalidateIntent}
                    />
                  ))}
                </div>
              ) : null}

              {/* Entitlement check rows (shown only if no OAuth or they failed) */}
              {hasEntitlement && !hasOAuth && !hasLicense ? (
                <div className="vp-section">
                  {entitlementMethods.map((req) => (
                    <EntitlementRow
                      key={req.methodKey}
                      intentId={intentId}
                      requirement={req}
                      provider={providersByKey.get(req.providerKey) ?? null}
                      verifiedMethodKey={verifiedMethodKey}
                      isAutoChecking={isAutoChecking}
                      onSuccess={invalidateIntent}
                    />
                  ))}
                </div>
              ) : null}
            </>
          )}

          {/* Footer */}
          <div className="vp-card-footer">
            <p className="vp-footer-note">
              Verification is handled securely in your browser. Unity only receives access after the
              server confirms your purchase.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
