import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
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
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';

export const Route = createFileRoute('/verify/purchase')({
  validateSearch: (search: Record<string, unknown>) => ({
    intent: typeof search.intent === 'string' ? search.intent : '',
    connected: typeof search.connected === 'string' ? search.connected : undefined,
  }),
  head: () => ({
    meta: [{ title: 'Verify Purchase | YUCP' }],
    links: routeStylesheetLinks(routeStyleHrefs.verifyPurchase),
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

// ---- sub-components -----------------------------------------------

function ProviderStatusBadge({ connected, label }: { connected: boolean; label?: string | null }) {
  if (connected) {
    return (
      <span className="vp-status-badge vp-status-badge--connected">
        <svg viewBox="0 0 16 16" aria-hidden="true" className="vp-status-badge-icon">
          <polyline points="3 8 6 11 13 5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {label ? `@${label}` : 'Connected'}
      </span>
    );
  }
  return <span className="vp-status-badge vp-status-badge--none">Not connected</span>;
}

interface MethodRowProps {
  intentId: string;
  requirement: UserVerificationIntentRequirement;
  linkedAccounts: UserAccountConnection[];
  provider: UserProvider | null;
  verifiedMethodKey: string | null;
  isAutoChecking: boolean;
  onSuccess: () => void;
}

function MethodRow({
  intentId,
  requirement,
  linkedAccounts,
  provider,
  verifiedMethodKey,
  isAutoChecking,
  onSuccess,
}: MethodRowProps) {
  const [licenseKey, setLicenseKey] = useState('');
  const queryClient = useQueryClient();

  const isVerified = verifiedMethodKey === requirement.methodKey;
  const activeLink = linkedAccounts.find((a) => a.status === 'active') ?? null;
  const expiredLink = !activeLink
    ? (linkedAccounts.find((a) => a.status === 'expired') ?? null)
    : null;
  const isConnected = activeLink !== null;
  const linkedLabel = activeLink?.providerUsername ?? activeLink?.providerUserId ?? null;

  const invalidateIntent = () => {
    queryClient.invalidateQueries({ queryKey: ['vp-intent', intentId] });
    onSuccess();
  };

  const entitlementMut = useMutation({
    mutationFn: () => verifyUserVerificationEntitlement(intentId, requirement.methodKey),
    onSuccess: invalidateIntent,
  });

  const providerLinkMut = useMutation({
    mutationFn: () => verifyUserVerificationProviderLink(intentId, requirement.methodKey),
    onSuccess: invalidateIntent,
  });

  const licenseMut = useMutation({
    mutationFn: () =>
      verifyUserVerificationManualLicense(intentId, requirement.methodKey, licenseKey),
    onSuccess: invalidateIntent,
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

  const cap = requirement.capability;
  const providerIconSrc = provider ? getProviderIconPath(provider) : null;

  // existing_entitlement: auto-checked silently; user can manually retry if it failed
  if (requirement.kind === 'existing_entitlement') {
    return (
      <div className={`vp-method-row${isVerified ? ' vp-method-row--verified' : ''}`}>
        <div className="vp-method-row-info">
          <div className="vp-method-provider">
            {providerIconSrc ? (
              <img src={providerIconSrc} alt="" className="vp-provider-icon" aria-hidden="true" />
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
              {cap.actionLabel}
            </button>
          )}
          {entitlementMut.isError ? (
            <p className="vp-method-error">Access not found with this account</p>
          ) : null}
        </div>
      </div>
    );
  }

  // buyer_provider_link: show connection status; connect or verify
  if (requirement.kind === 'buyer_provider_link') {
    return (
      <div className={`vp-method-row${isVerified ? ' vp-method-row--verified' : ''}`}>
        <div className="vp-method-row-info">
          <div className="vp-method-provider">
            {providerIconSrc ? (
              <img src={providerIconSrc} alt="" className="vp-provider-icon" aria-hidden="true" />
            ) : null}
            <span className="vp-provider-label-text">{requirement.providerLabel}</span>
            <ProviderStatusBadge connected={isConnected} label={linkedLabel} />
          </div>
          <p className="vp-method-title">{requirement.title}</p>
          <p className="vp-method-desc">
            {isConnected
              ? `Verify using the connected ${requirement.providerLabel} account${linkedLabel ? ` (${linkedLabel})` : ''}.`
              : expiredLink
                ? `Your ${requirement.providerLabel} connection expired. Reconnect to verify.`
                : (requirement.description ??
                  `Connect your ${requirement.providerLabel} account to verify your purchase.`)}
          </p>
        </div>

        <div className="vp-method-row-action">
          {isVerified ? (
            <span className="vp-status-badge vp-status-badge--connected">Verified</span>
          ) : isConnected ? (
            <button
              type="button"
              className={`vp-action-btn${providerLinkMut.isPending ? ' btn-loading' : ''}`}
              onClick={() => providerLinkMut.mutate()}
              disabled={providerLinkMut.isPending}
            >
              {providerLinkMut.isPending ? (
                <>
                  <span className="btn-loading-spinner" aria-hidden="true" />
                  Verifying...
                </>
              ) : (
                `Verify with ${requirement.providerLabel}`
              )}
            </button>
          ) : (
            <button
              type="button"
              className={`vp-action-btn${connectMut.isPending ? ' btn-loading' : ''}`}
              onClick={() => connectMut.mutate()}
              disabled={connectMut.isPending}
            >
              {connectMut.isPending ? (
                <>
                  <span className="btn-loading-spinner" aria-hidden="true" />
                  {expiredLink ? 'Reconnecting...' : 'Connecting...'}
                </>
              ) : expiredLink ? (
                `Reconnect ${requirement.providerLabel}`
              ) : (
                `Connect ${requirement.providerLabel}`
              )}
            </button>
          )}
          {providerLinkMut.isError ? (
            <p className="vp-method-error">
              Purchase not found — make sure you bought on this account
            </p>
          ) : null}
          {connectMut.isError ? (
            <p className="vp-method-error">
              Could not connect to {requirement.providerLabel}. Please try again.
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  // manual_license: license key input form
  return (
    <div className={`vp-method-row${isVerified ? ' vp-method-row--verified' : ''}`}>
      <div className="vp-method-row-info">
        <div className="vp-method-provider">
          {providerIconSrc ? (
            <img src={providerIconSrc} alt="" className="vp-provider-icon" aria-hidden="true" />
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

// ---- page component -----------------------------------------------

function VerifyPurchasePage() {
  const { intent: intentId, connected: justConnectedProvider } = useSearch({
    from: '/verify/purchase',
  });

  const [isVisible, setIsVisible] = useState(false);
  const [redirectCountdown, setRedirectCountdown] = useState(5);
  const [successHandled, setSuccessHandled] = useState(false);

  // Track whether auto-checks have been initiated (to fire exactly once)
  const [entitlementCheckState, setEntitlementCheckState] = useState<'idle' | 'checking' | 'done'>(
    'idle'
  );
  const [oauthReturnState, setOauthReturnState] = useState<'idle' | 'checking' | 'done'>('idle');

  const queryClient = useQueryClient();

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

  // Auto-check existing_entitlement on first load (fires once)
  useEffect(() => {
    if (entitlementCheckState !== 'idle') return;
    if (!intent || intent.status !== 'pending') return;

    const method = intent.requirements.find((r) => r.kind === 'existing_entitlement');
    if (!method) {
      setEntitlementCheckState('done');
      return;
    }

    setEntitlementCheckState('checking');
    verifyUserVerificationEntitlement(intentId, method.methodKey)
      .then(() => queryClient.invalidateQueries({ queryKey: ['vp-intent', intentId] }))
      .catch(() => {
        // Failure shown per-method row when user retries manually
      })
      .finally(() => setEntitlementCheckState('done'));
  }, [intent, intentId, entitlementCheckState, queryClient]);

  // Auto-verify provider link after OAuth return (fires once)
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

    // Clean the ?connected= from URL immediately so a refresh doesn't re-trigger
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

  // Auto-redirect countdown on verified
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

  // Build lookup maps for providers and accounts
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

  // ---- empty/invalid intent
  if (!intentId) {
    return (
      <div className={wrapperClass}>
        <BackgroundCanvasRoot />
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
        <BackgroundCanvasRoot />
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
    return (
      <div className={wrapperClass}>
        <BackgroundCanvasRoot />
        <main className={mainClass}>
          <div className="vp-card vp-card--error fade-up" style={{ animationDelay: '0.1s' }}>
            <h1 className="vp-package-name">Verification not found</h1>
            <p className="vp-card-subtitle">
              This verification link is invalid or has already expired. Return to Unity and restart
              the verification flow.
            </p>
          </div>
        </main>
      </div>
    );
  }

  // ---- expired / cancelled
  if (intent.status === 'expired' || intent.status === 'cancelled') {
    return (
      <div className={wrapperClass}>
        <BackgroundCanvasRoot />
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
        <BackgroundCanvasRoot />
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
  return (
    <div className={wrapperClass}>
      <BackgroundCanvasRoot />
      <main className={mainClass}>
        <div className="vp-card fade-up" style={{ animationDelay: '0.1s' }}>
          <div className="vp-card-header">
            <p className="vp-eyebrow">Verify your purchase</p>
            <h1 className="vp-package-name">{intent.packageName || intent.packageId}</h1>
            {intent.errorMessage ? (
              <div className="vp-error-banner">{intent.errorMessage}</div>
            ) : null}
          </div>

          {isAutoChecking ? (
            <div className="vp-checking-section">
              <span className="vp-spinner vp-spinner--lg" aria-hidden="true" />
              <p className="vp-checking-text">Checking your access...</p>
            </div>
          ) : (
            <div className="vp-section">
              <p className="vp-section-title">Choose a verification method</p>
              {intent.requirements.map((req) => (
                <MethodRow
                  key={req.methodKey}
                  intentId={intentId}
                  requirement={req}
                  linkedAccounts={accountsByProvider.get(req.providerKey) ?? []}
                  provider={providersByKey.get(req.providerKey) ?? null}
                  verifiedMethodKey={intent.verifiedMethodKey}
                  isAutoChecking={isAutoChecking}
                  onSuccess={() =>
                    queryClient.invalidateQueries({ queryKey: ['vp-intent', intentId] })
                  }
                />
              ))}
            </div>
          )}

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
