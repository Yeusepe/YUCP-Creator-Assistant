import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createLazyFileRoute, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import {
  AccountInlineError,
  AccountPage,
  AccountSectionCard,
} from '@/components/account/AccountPage';
import { DashboardListSkeleton } from '@/components/dashboard/DashboardSkeletons';
import { ProviderChip } from '@/components/ui/ProviderChip';
import { StatusChip } from '@/components/ui/StatusChip';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { YucpInput } from '@/components/ui/YucpInput';
import {
  formatAccountDateTime,
  getUserVerificationIntent,
  type UserVerificationIntent,
  verifyUserVerificationEntitlement,
  verifyUserVerificationManualLicense,
  verifyUserVerificationProviderLink,
} from '@/lib/account';
import {
  getUserAccountsQueryKey,
  listUserAccounts,
  listUserProviders,
  startUserVerify,
  type UserAccountConnection,
  type UserProvider,
} from '@/lib/dashboard';
import { getSafeInternalRedirectTarget } from '@/lib/safeRedirects';

export const Route = createLazyFileRoute('/_authenticated/account/verify')({
  component: AccountVerifyPage,
});

function formatVerificationStatus(status: UserVerificationIntent['status']): string {
  switch (status) {
    case 'pending':
      return 'Waiting for verification';
    case 'verified':
      return 'Verified';
    case 'expired':
      return 'Expired';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Needs attention';
    default:
      return 'Status unavailable';
  }
}

function getSafeReturnTo(value: string | null | undefined): string | null {
  if (!value || typeof window === 'undefined') return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol === 'https:') {
      return url.toString();
    }
    const isLoopback =
      url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return isLoopback ? url.toString() : null;
  } catch {
    return null;
  }
}

function buildReturnToUrl(intent: UserVerificationIntent): string | null {
  const safeReturnTo = getSafeReturnTo(intent.returnUrl);
  if (!safeReturnTo || !intent.grantToken) {
    return safeReturnTo;
  }
  const url = new URL(safeReturnTo);
  url.searchParams.set('intent_id', intent.id);
  url.searchParams.set('grant', intent.grantToken);
  return url.toString();
}

function MethodCard({
  intentId,
  method,
  verifiedMethodKey,
  provider,
  linkedAccounts,
}: Readonly<{
  intentId: string;
  method: UserVerificationIntent['requirements'][number];
  verifiedMethodKey: string | null;
  provider: UserProvider | null;
  linkedAccounts: UserAccountConnection[];
}>) {
  const [licenseKey, setLicenseKey] = useState('');
  const queryClient = useQueryClient();
  const toast = useToast();
  const isVerifiedMethod = verifiedMethodKey === method.methodKey;
  const capability = method.capability;
  const inputConfig = capability.input;
  const returnUrl = `/account/verify?intent=${encodeURIComponent(intentId)}`;
  const activeLink = linkedAccounts.find((link) => link.status === 'active') ?? null;
  const expiredLink = linkedAccounts.find((link) => link.status === 'expired') ?? null;
  const activeLinkLabel = activeLink?.providerUsername?.trim() || activeLink?.label?.trim() || null;

  const entitlementMut = useMutation({
    mutationFn: () => verifyUserVerificationEntitlement(intentId, method.methodKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-verification-intent', intentId] });
      toast.success('Verification complete', {
        description: `${method.title} confirmed your purchase access.`,
      });
    },
    onError: (error) => {
      toast.error('We couldn’t verify access', {
        description: error instanceof Error ? error.message : `Try ${method.title} again.`,
      });
    },
  });

  const manualMut = useMutation({
    mutationFn: () => verifyUserVerificationManualLicense(intentId, method.methodKey, licenseKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-verification-intent', intentId] });
      toast.success('Verification complete', {
        description: `${method.title} confirmed your purchase access.`,
      });
    },
    onError: (error) => {
      toast.error('We couldn’t verify this license', {
        description: error instanceof Error ? error.message : 'Check the license and try again.',
      });
    },
  });

  const providerLinkMut = useMutation({
    mutationFn: () => verifyUserVerificationProviderLink(intentId, method.methodKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-verification-intent', intentId] });
      toast.success('Verification complete', {
        description: `${method.title} confirmed your purchase access.`,
      });
    },
    onError: (error) => {
      toast.error('We couldn’t verify the connected account', {
        description:
          error instanceof Error
            ? error.message
            : `Connect ${method.providerLabel} in your account, then try again.`,
      });
    },
  });

  const connectProviderMut = useMutation({
    mutationFn: async () => {
      if (!provider) {
        throw new Error(
          `Provider '${method.providerLabel}' does not support direct account linking`
        );
      }
      const { redirectUrl } = await startUserVerify(method.providerKey, returnUrl);
      return { redirectUrl: getSafeInternalRedirectTarget(redirectUrl) };
    },
    onSuccess: ({ redirectUrl }) => {
      window.location.href = redirectUrl;
    },
    onError: (error) => {
      toast.error('We couldn’t connect this store', {
        description:
          error instanceof Error ? error.message : `Try connecting ${method.providerLabel} again.`,
      });
    },
  });

  return (
    <div className="account-list-row">
      <div className="account-list-row-info">
        <p className="account-list-row-name">{method.title}</p>
        <p className="account-list-row-meta">
          <ProviderChip name={method.providerLabel} />
          {isVerifiedMethod ? <StatusChip status="verified" /> : null}
        </p>
        {method.description ? <p className="account-feature-copy">{method.description}</p> : null}
        {method.kind === 'buyer_provider_link' ? (
          <p className="account-feature-copy">
            {activeLinkLabel ? (
              `Connected as ${activeLinkLabel}. Use this account to verify access for the current product.`
            ) : activeLink ? (
              <>
                <span>Connected store account</span>. Use this account to verify access for the
                current product.
              </>
            ) : expiredLink ? (
              `Your connected ${method.providerLabel} account has expired. Reconnect it here, then continue.`
            ) : (
              `No ${method.providerLabel} account is connected yet. Connect it here to verify the purchase.`
            )}
          </p>
        ) : null}
      </div>

      <div className="account-list-row-actions">
        {method.kind === 'existing_entitlement' ? (
          <YucpButton
            yucp="primary"
            pill
            isLoading={entitlementMut.isPending}
            isDisabled={entitlementMut.isPending || isVerifiedMethod}
            onClick={() => entitlementMut.mutate()}
          >
            {entitlementMut.isPending
              ? 'Checking...'
              : isVerifiedMethod
                ? 'Verified'
                : capability.actionLabel}
          </YucpButton>
        ) : method.kind === 'buyer_provider_link' ? (
          <>
            {activeLink ? (
              <YucpButton
                yucp="primary"
                pill
                isLoading={providerLinkMut.isPending}
                isDisabled={providerLinkMut.isPending || isVerifiedMethod}
                onClick={() => providerLinkMut.mutate()}
              >
                {providerLinkMut.isPending
                  ? 'Checking...'
                  : isVerifiedMethod
                    ? 'Verified'
                    : capability.actionLabel}
              </YucpButton>
            ) : provider ? (
              <YucpButton
                yucp="primary"
                pill
                isLoading={connectProviderMut.isPending}
                isDisabled={connectProviderMut.isPending}
                onClick={() => connectProviderMut.mutate()}
              >
                {connectProviderMut.isPending
                  ? expiredLink
                    ? 'Reconnecting...'
                    : 'Connecting...'
                  : expiredLink
                    ? `Reconnect ${method.providerLabel}`
                    : `Connect ${method.providerLabel}`}
              </YucpButton>
            ) : null}
            <a href="/account/connections" className="account-btn account-btn--secondary">
              {activeLink ? 'Manage links' : 'Open connections'}
            </a>
          </>
        ) : (
          <>
            <YucpInput
              type={inputConfig?.masked === false ? 'text' : 'password'}
              mono
              value={licenseKey}
              onValueChange={setLicenseKey}
              placeholder={inputConfig?.placeholder ?? 'Enter your license key'}
              aria-label={inputConfig?.label ?? 'License Key'}
              autoComplete="off"
              spellCheck={false}
            />
            <YucpButton
              yucp="primary"
              pill
              isLoading={manualMut.isPending}
              isDisabled={manualMut.isPending || isVerifiedMethod || licenseKey.trim().length === 0}
              onClick={() => manualMut.mutate()}
            >
              {manualMut.isPending
                ? 'Verifying...'
                : isVerifiedMethod
                  ? 'Verified'
                  : (inputConfig?.submitLabel ?? capability.actionLabel)}
            </YucpButton>
          </>
        )}
      </div>
    </div>
  );
}

function AccountVerifyPage() {
  const { intent } = useSearch({ from: '/_authenticated/account/verify' });
  const [redirectCountdown, setRedirectCountdown] = useState(5);
  const toast = useToast();

  const intentQuery = useQuery({
    queryKey: ['user-verification-intent', intent],
    queryFn: () => getUserVerificationIntent(intent),
    enabled: intent.length > 0,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && data.status === 'pending' ? 3000 : false;
    },
  });

  const verificationIntent = intentQuery.data;
  const needsBuyerProviderLinks =
    verificationIntent?.requirements.some((method) => method.kind === 'buyer_provider_link') ??
    false;
  const providersQuery = useQuery({
    queryKey: ['user-providers'],
    queryFn: listUserProviders,
    enabled: needsBuyerProviderLinks,
  });
  const accountsQuery = useQuery({
    queryKey: getUserAccountsQueryKey(),
    queryFn: listUserAccounts,
    enabled: needsBuyerProviderLinks,
  });
  const returnToUrl = useMemo(
    () => (verificationIntent ? buildReturnToUrl(verificationIntent) : null),
    [verificationIntent]
  );
  const providersByKey = useMemo(
    () => new Map((providersQuery.data ?? []).map((provider) => [provider.id, provider])),
    [providersQuery.data]
  );
  const linkedAccountsByProvider = useMemo(() => {
    const result = new Map<string, UserAccountConnection[]>();
    for (const account of accountsQuery.data ?? []) {
      const providerAccounts = result.get(account.provider) ?? [];
      providerAccounts.push(account);
      result.set(account.provider, providerAccounts);
    }
    return result;
  }, [accountsQuery.data]);

  useEffect(() => {
    if (!verificationIntent || verificationIntent.status !== 'verified' || !returnToUrl) {
      setRedirectCountdown(5);
      return;
    }

    setRedirectCountdown(5);
    const timer = window.setInterval(() => {
      setRedirectCountdown((current) => {
        if (current <= 1) {
          window.clearInterval(timer);
          window.location.href = returnToUrl;
          return 0;
        }
        return current - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [verificationIntent, returnToUrl]);

  useEffect(() => {
    if (intentQuery.isError) {
      toast.error('We couldn’t load the verification flow', {
        description: 'Refresh the page or start again from Unity.',
      });
    }
  }, [intentQuery.isError, toast]);

  if (!intent) {
    return (
      <AccountPage>
        <AccountSectionCard
          className="bento-col-12"
          eyebrow="Verification"
          title="Verification link missing"
          description="Open this page from Unity so we know which product to verify."
        >
          <AccountInlineError message="No verification link was supplied." />
        </AccountSectionCard>
      </AccountPage>
    );
  }

  return (
    <AccountPage>
      <AccountSectionCard
        className="bento-col-8 animate-in animate-in-delay-1"
        eyebrow="Hosted verification"
        title={
          verificationIntent?.packageName || verificationIntent?.packageId || 'Verify your purchase'
        }
        description="Confirm your purchase here. Unity will continue when the product is ready to install."
      >
        {intentQuery.isLoading ? <DashboardListSkeleton rows={4} /> : null}
        {intentQuery.isError ? (
          <AccountInlineError message="We couldn’t load the verification request. Start again from Unity." />
        ) : null}
        {verificationIntent ? (
          <>
            <div className="account-kv-list">
              <div className="account-kv-row">
                <span className="account-kv-label">Status</span>
                <span className="account-kv-value">
                  {formatVerificationStatus(verificationIntent.status)}
                </span>
              </div>
              <div className="account-kv-row">
                <span className="account-kv-label">Product</span>
                <span className="account-kv-value">{verificationIntent.packageId}</span>
              </div>
              <div className="account-kv-row">
                <span className="account-kv-label">Expires</span>
                <span className="account-kv-value">
                  {formatAccountDateTime(verificationIntent.expiresAt)}
                </span>
              </div>
            </div>

            {verificationIntent.errorMessage ? (
              <AccountInlineError message={verificationIntent.errorMessage} />
            ) : null}

            {verificationIntent.requirements.map((method) => (
              <MethodCard
                key={method.methodKey}
                intentId={verificationIntent.id}
                method={method}
                verifiedMethodKey={verificationIntent.verifiedMethodKey}
                provider={providersByKey.get(method.providerKey) ?? null}
                linkedAccounts={linkedAccountsByProvider.get(method.providerKey) ?? []}
              />
            ))}

            {verificationIntent.status === 'verified' ? (
              <div className="account-note-stack">
                <p className="account-feature-copy">
                  Verification is complete. Return to Unity to finish redemption.
                </p>
                {returnToUrl ? (
                  <p className="account-feature-copy">
                    Returning to your app in {redirectCountdown} second
                    {redirectCountdown === 1 ? '' : 's'}.
                  </p>
                ) : null}
                {returnToUrl ? (
                  <a href={returnToUrl} className="account-btn account-btn--connect">
                    Return to app
                  </a>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-4 animate-in animate-in-delay-2"
        eyebrow="About verification"
        title="Why verification happens here"
        description="Unity starts the process, but the browser handles sign-in and purchase checks. Your store credentials stay out of the Unity editor."
      >
        <div className="account-note-stack">
          <p className="account-feature-copy">
            We prepare access after your purchase is confirmed.
          </p>
          <p className="account-feature-copy">
            Unity receives what it needs to finish this installation on the device you started it
            on.
          </p>
        </div>
      </AccountSectionCard>
    </AccountPage>
  );
}
