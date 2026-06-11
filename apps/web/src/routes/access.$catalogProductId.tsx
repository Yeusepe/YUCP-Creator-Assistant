import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { CheckCircle2, ChevronDown, Copy, ExternalLink, Lock, Package, Store } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import { CloudBackground } from '@/components/three/CloudBackground';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { usePublicAuth } from '@/hooks/usePublicAuth';
import {
  redeemBuyerBackstageVerificationIntent,
  requestUserBackstageRepoAccess,
} from '@/lib/backstageAccess';
import { createBuyerProductAccessVerificationIntent } from '@/lib/productAccess';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { fetchBuyerProductAccess } from '@/lib/server/productAccess';

const accessRouteApi = getRouteApi('/access/$catalogProductId');
const BUYER_PRODUCT_ACCESS_VERIFICATION_STORAGE_PREFIX = 'yucp:buyer-product-access-verification:';

export const Route = createFileRoute('/access/$catalogProductId')({
  validateSearch: (search: Record<string, unknown>) => ({
    intent_id: typeof search.intent_id === 'string' ? search.intent_id : undefined,
    grant: typeof search.grant === 'string' ? search.grant : undefined,
  }),
  head: () => ({
    meta: [{ title: 'Product Access | YUCP' }],
    links: routeStylesheetLinks(routeStyleHrefs.verifyPurchase, routeStyleHrefs.productAccess),
  }),
  pendingComponent: BuyerProductAccessPending,
  errorComponent: BuyerProductAccessError,
  loader: async ({ params }) =>
    fetchBuyerProductAccess({
      data: {
        catalogProductId: params.catalogProductId,
      },
    }),
  component: BuyerProductAccessPage,
});

function PageShell({
  children,
  isVisible = true,
}: Readonly<{
  children: ReactNode;
  isVisible?: boolean;
}>) {
  return (
    <div className="vp-page">
      <CloudBackground variant="default" />
      <div className="vp-wrapper">
        <main className={`vp-main vp-main--buyer-access${isVisible ? ' is-visible' : ''}`}>
          {children}
        </main>
      </div>
    </div>
  );
}

function PackageRow({
  packageId,
  displayName,
  latestPublishedVersion,
}: Readonly<{
  packageId: string;
  displayName: string | null;
  latestPublishedVersion: string | null;
}>) {
  return (
    <div className="vpa-package">
      <span className="vpa-package-icon" aria-hidden="true">
        <Package className="size-4" />
      </span>
      <div className="vpa-package-text">
        <p className="vpa-package-name">{displayName ?? packageId}</p>
        <p className="vpa-package-id">{packageId}</p>
      </div>
      <span className="vpa-version">
        {latestPublishedVersion ? `v${latestPublishedVersion}` : 'Pending'}
      </span>
    </div>
  );
}

function ProgressStep({
  index,
  currentStep,
  label,
}: Readonly<{
  index: number;
  currentStep: number;
  label: string;
}>) {
  const status = index < currentStep ? 'complete' : index === currentStep ? 'active' : 'upcoming';

  return (
    <li className={`vpa-step vpa-step--${status}`}>
      <span className="vpa-step-dot" aria-hidden="true">
        {status === 'complete' ? <CheckCircle2 className="size-4" /> : index + 1}
      </span>
      <span className="vpa-step-label">{label}</span>
    </li>
  );
}

interface PendingBuyerProductAccessVerification {
  catalogProductId: string;
  codeVerifier: string;
  machineFingerprint: string;
}

function getPendingBuyerProductAccessVerificationStorageKey(intentId: string): string {
  return `${BUYER_PRODUCT_ACCESS_VERIFICATION_STORAGE_PREFIX}${intentId}`;
}

function storePendingBuyerProductAccessVerification(
  intentId: string,
  pending: PendingBuyerProductAccessVerification
): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      getPendingBuyerProductAccessVerificationStorageKey(intentId),
      JSON.stringify(pending)
    );
  } catch {
    // The return page will ask the buyer to restart verification if storage is unavailable.
  }
}

function readPendingBuyerProductAccessVerification(
  intentId: string,
  catalogProductId: string
): PendingBuyerProductAccessVerification | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(
      getPendingBuyerProductAccessVerificationStorageKey(intentId)
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingBuyerProductAccessVerification>;
    if (
      parsed.catalogProductId !== catalogProductId ||
      typeof parsed.codeVerifier !== 'string' ||
      typeof parsed.machineFingerprint !== 'string'
    ) {
      return null;
    }
    return {
      catalogProductId,
      codeVerifier: parsed.codeVerifier,
      machineFingerprint: parsed.machineFingerprint,
    };
  } catch {
    return null;
  }
}

function removePendingBuyerProductAccessVerification(intentId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(getPendingBuyerProductAccessVerificationStorageKey(intentId));
  } catch {
    // Ignore storage cleanup failures.
  }
}

function removeVerificationReturnParams(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.delete('grant');
  url.searchParams.delete('intent_id');
  window.history.replaceState({}, '', url.toString());
}

function BuyerProductAccessPage() {
  const { catalogProductId } = accessRouteApi.useParams();
  const search = accessRouteApi.useSearch();
  const accessData = accessRouteApi.useLoaderData();
  const toast = useToast();
  const { isAuthenticated, isPending: isAuthPending, signIn } = usePublicAuth();
  const grant = search.grant;
  const intentId = search.intent_id;

  const repoAccessQuery = useQuery({
    queryKey: ['buyer-backstage-repo-access', catalogProductId],
    queryFn: () => requestUserBackstageRepoAccess({ catalogProductId }),
    enabled:
      isAuthenticated &&
      accessData.accessState.hasActiveEntitlement === true &&
      accessData.accessState.hasPublishedPackages,
    retry: false,
  });

  const redemptionQuery = useQuery({
    queryKey: ['buyer-product-access-verification-redemption', catalogProductId, intentId, grant],
    queryFn: async () => {
      if (!grant || !intentId) {
        throw new Error('Verification grant and intent are required.');
      }
      const pending = readPendingBuyerProductAccessVerification(intentId, catalogProductId);
      if (!pending) {
        throw new Error('Verification session was not found. Restart verification from this page.');
      }
      await redeemBuyerBackstageVerificationIntent({
        intentId,
        grantToken: grant,
        codeVerifier: pending.codeVerifier,
        machineFingerprint: pending.machineFingerprint,
      });
      const repoAccess = await requestUserBackstageRepoAccess({ catalogProductId });
      removePendingBuyerProductAccessVerification(intentId);
      removeVerificationReturnParams();
      return repoAccess;
    },
    enabled: isAuthenticated && Boolean(grant) && Boolean(intentId),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const startAccessMutation = useMutation({
    mutationFn: async () => {
      if (!isAuthenticated) {
        await signIn(window.location.href);
        return;
      }

      const response = await createBuyerProductAccessVerificationIntent(catalogProductId, {
        returnTo: accessData.product.accessPagePath,
      });
      storePendingBuyerProductAccessVerification(response.intentId, {
        catalogProductId,
        codeVerifier: response.codeVerifier,
        machineFingerprint: response.machineFingerprint,
      });
      window.location.href = response.verificationUrl;
    },
    onError: () => {
      toast.error('Could not start verification', {
        description: 'Please refresh and try again.',
      });
    },
  });

  async function handleCopyValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(label);
    } catch {
      toast.error('Could not copy', {
        description: 'Please copy the value manually.',
      });
    }
  }

  const { product, accessState } = accessData;
  const isViewerPending = isAuthPending;
  const isReturningFromVerification = Boolean(grant && intentId && isAuthenticated);
  const hasAccess =
    accessState.hasActiveEntitlement ||
    redemptionQuery.isSuccess ||
    (isReturningFromVerification && redemptionQuery.isPending);
  // packagePreview is only populated once the buyer is signed in; hasPublishedPackages is the
  // source of truth for whether a package exists at all (true even while the preview is hidden).
  const packageCount = product.packagePreview.length;
  const hasPublishedPackages = accessState.hasPublishedPackages;
  const metaText =
    packageCount > 0
      ? `${packageCount} Unity package${packageCount === 1 ? '' : 's'} · Private VCC access`
      : 'Private VCC access';
  const actionTitle = hasAccess
    ? "You're all set"
    : isAuthenticated
      ? 'Verify your purchase'
      : 'Sign in to get started';
  const actionDesc = hasAccess
    ? 'Add the package source to VCC, then install the package in Unity.'
    : isAuthenticated
      ? `Confirm your ${product.providerLabel} purchase to unlock this package for VCC.`
      : 'Sign in with the Creator Identity you use in VCC so this purchase links to your account.';
  const currentStep = isViewerPending ? 0 : hasAccess ? 2 : isAuthenticated ? 1 : 0;
  const repoAccess = redemptionQuery.data ?? repoAccessQuery.data;
  const repositoryUrl = repoAccess?.repositoryUrl ?? null;
  const isRepoReady = Boolean(repoAccess?.addRepoUrl);
  const isRepoPending = hasAccess && (repoAccessQuery.isLoading || redemptionQuery.isLoading);
  const isRepoError = repoAccessQuery.isError || redemptionQuery.isError;
  const [isManualSetupOpen, setIsManualSetupOpen] = useState(false);

  if (isViewerPending) {
    return <PageLoadingOverlay />;
  }

  return (
    <PageShell>
      <div className="vp-card vpa-card">
        <header className="vpa-head">
          <div className="vpa-thumb">
            {product.thumbnailUrl ? (
              <img className="vpa-thumb-img" src={product.thumbnailUrl} alt="" />
            ) : (
              <Package className="size-7" aria-hidden="true" />
            )}
          </div>
          <div className="vpa-head-text">
            <span className="vpa-provider">
              <Store className="size-3.5" />
              {product.providerLabel}
            </span>
            <h1 className="vpa-title">{product.displayName}</h1>
            <p className="vpa-meta">{metaText}</p>
          </div>
        </header>

        <ol className="vpa-steps" aria-label="Access steps">
          <ProgressStep index={0} currentStep={currentStep} label="Sign in" />
          <ProgressStep index={1} currentStep={currentStep} label="Verify" />
          <ProgressStep index={2} currentStep={currentStep} label="Add to VCC" />
        </ol>

        <section className="vpa-action">
          {search.intent_id ? (
            <div className="vpa-callout vpa-callout--success">
              <CheckCircle2 className="size-4" />
              Purchase confirmed. Continue with VCC below.
            </div>
          ) : null}
          {!accessState.hasPublishedPackages ? (
            <div className="vpa-callout vpa-callout--warning">
              This product is linked, but the creator has not published a package yet.
            </div>
          ) : null}

          <div>
            <h2 className="vpa-action-title">{actionTitle}</h2>
            <p className="vpa-action-desc">{actionDesc}</p>
          </div>

          {hasAccess ? (
            <>
              <YucpButton
                yucp="primary"
                pill
                className="vpa-cta"
                isLoading={isRepoPending}
                isDisabled={!isRepoReady}
                onPress={() => {
                  if (repoAccess?.addRepoUrl) {
                    window.location.href = repoAccess.addRepoUrl;
                  }
                }}
              >
                {isRepoPending ? 'Preparing VCC access...' : 'Add to VCC'}
              </YucpButton>
              {isRepoError ? (
                <p className="vpa-note vpa-note--error">
                  We could not prepare your VCC handoff. Refresh and try again.
                </p>
              ) : !isRepoPending && !isRepoReady ? (
                <p className="vpa-note">
                  Your purchase is verified. The VCC button is still being prepared, refresh in a
                  moment.
                </p>
              ) : null}
            </>
          ) : (
            <YucpButton
              yucp="primary"
              pill
              className="vpa-cta"
              isLoading={startAccessMutation.isPending}
              isDisabled={!accessState.hasPublishedPackages || isAuthPending}
              onPress={() => startAccessMutation.mutate()}
            >
              {isAuthenticated
                ? startAccessMutation.isPending
                  ? 'Starting verification...'
                  : 'Verify purchase'
                : startAccessMutation.isPending
                  ? 'Starting sign-in...'
                  : 'Sign in to continue'}
            </YucpButton>
          )}
        </section>

        {hasPublishedPackages ? (
          <section className="vpa-section">
            <h3 className="vpa-section-title">
              {packageCount > 1 ? `What's included (${packageCount})` : "What's included"}
            </h3>
            {packageCount > 0 ? (
              product.packagePreview.map((packageLink) => (
                <PackageRow
                  key={packageLink.packageId}
                  packageId={packageLink.packageId}
                  displayName={packageLink.displayName}
                  latestPublishedVersion={packageLink.latestPublishedVersion}
                />
              ))
            ) : (
              <div className="vpa-locked">
                <span className="vpa-package-icon" aria-hidden="true">
                  <Lock className="size-4" />
                </span>
                <div className="vpa-package-text">
                  <p className="vpa-locked-title">Private package included</p>
                  <p className="vpa-locked-desc">Sign in to see the package you&apos;ll install.</p>
                </div>
              </div>
            )}
          </section>
        ) : null}

        {hasAccess && repositoryUrl ? (
          <section className="vpa-manual">
            <button
              type="button"
              className="vpa-manual-toggle"
              aria-expanded={isManualSetupOpen}
              onClick={() => setIsManualSetupOpen((value) => !value)}
            >
              Manual setup
              <ChevronDown
                className={`size-4 vpa-manual-toggle-icon${isManualSetupOpen ? ' is-open' : ''}`}
              />
            </button>
            <div
              className={`vpa-manual-panel${isManualSetupOpen ? ' is-open' : ''}`}
              aria-hidden={!isManualSetupOpen}
            >
              <p className="vpa-manual-copy">
                Prefer to add it yourself? In VCC choose <strong>Add Repository</strong> and paste
                this private URL.
              </p>
              <div className="vpa-repo-box">
                <p className="vpa-repo-url">{repositoryUrl}</p>
                <YucpButton
                  yucp="ghost"
                  className="vpa-repo-copy"
                  onPress={() => handleCopyValue(repositoryUrl, 'Repo URL copied')}
                >
                  <Copy className="size-3.5" />
                  Copy
                </YucpButton>
              </div>
            </div>
          </section>
        ) : null}

        <footer className="vpa-foot">
          {isAuthenticated ? (
            <Link to="/account/licenses" className="vpa-foot-link">
              My purchases
            </Link>
          ) : null}
          {product.storefrontUrl ? (
            <a
              href={product.storefrontUrl}
              target="_blank"
              rel="noreferrer"
              className="vpa-foot-link"
            >
              <ExternalLink className="size-4" />
              Store listing
            </a>
          ) : null}
        </footer>
      </div>
    </PageShell>
  );
}

function BuyerProductAccessPending() {
  return <PageLoadingOverlay />;
}

function BuyerProductAccessError() {
  return (
    <PageShell>
      <div className="vp-card vp-card--error">
        <h1 className="vp-package-name">We could not load this product access page</h1>
        <p className="vp-card-subtitle">
          Open the link again from your store receipt or your library, then try once more.
        </p>
        <div className="mt-6 flex justify-center">
          <Link to="/account/licenses" className="vp-primary-btn">
            Open verified purchases
          </Link>
        </div>
      </div>
    </PageShell>
  );
}
