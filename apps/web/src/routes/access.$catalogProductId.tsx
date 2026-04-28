import { Card, Separator } from '@heroui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import {
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  KeyRound,
  LogIn,
  Package,
  ShieldCheck,
  Store,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import { CloudBackground } from '@/components/three/CloudBackground';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { usePublicAuth } from '@/hooks/usePublicAuth';
import { requestBackstageRepoAccess } from '@/lib/packages';
import { createBuyerProductAccessVerificationIntent } from '@/lib/productAccess';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { fetchBuyerProductAccess } from '@/lib/server/productAccess';

const accessRouteApi = getRouteApi('/access/$catalogProductId');

export const Route = createFileRoute('/access/$catalogProductId')({
  validateSearch: (search: Record<string, unknown>) => ({
    intent_id: typeof search.intent_id === 'string' ? search.intent_id : undefined,
    grant: typeof search.grant === 'string' ? search.grant : undefined,
  }),
  head: () => ({
    meta: [{ title: 'Product Access | YUCP' }],
    links: routeStylesheetLinks(routeStyleHrefs.verifyPurchase),
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

function ProductPreview({
  packageId,
  displayName,
  latestPublishedVersion,
}: Readonly<{
  packageId: string;
  displayName: string | null;
  latestPublishedVersion: string | null;
}>) {
  return (
    <div className="vp-access-item-card">
      <div className="vp-access-item-icon">
        <Package className="size-4" />
      </div>
      <div className="vp-access-item-content">
        <p className="vp-access-item-title">{displayName ?? packageId}</p>
        <p className="vp-access-item-description break-all font-mono">{packageId}</p>
      </div>
      <div className="vp-access-item-action">
        <span className="vp-status-badge vp-status-badge--none">
          {latestPublishedVersion ? `v${latestPublishedVersion}` : 'Pending'}
        </span>
      </div>
    </div>
  );
}

function AccessStep({
  index,
  currentStep,
  title,
  description,
}: Readonly<{
  index: number;
  currentStep: number;
  title: string;
  description: string;
}>) {
  const status = index < currentStep ? 'complete' : index === currentStep ? 'active' : 'inactive';

  return (
    <li className={`vp-access-step vp-access-step--${status}`}>
      <span className="vp-access-step-indicator" aria-hidden="true">
        {status === 'complete' ? <CheckCircle2 className="size-4" /> : index + 1}
      </span>
      <div className="vp-access-step-copy">
        <p className="vp-access-step-title">{title}</p>
        <p className="vp-access-step-description">{description}</p>
      </div>
    </li>
  );
}

function BuyerProductAccessPage() {
  const { catalogProductId } = accessRouteApi.useParams();
  const search = accessRouteApi.useSearch();
  const accessData = accessRouteApi.useLoaderData();
  const toast = useToast();
  const { isAuthenticated, isPending: isAuthPending, signIn } = usePublicAuth();

  const repoAccessQuery = useQuery({
    queryKey: ['buyer-backstage-repo-access', catalogProductId],
    queryFn: requestBackstageRepoAccess,
    enabled:
      isAuthenticated &&
      accessData.accessState.hasActiveEntitlement === true &&
      accessData.accessState.hasPublishedPackages,
    retry: false,
  });

  if (search.grant && typeof window !== 'undefined') {
    queueMicrotask(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete('grant');
      window.history.replaceState({}, '', url.toString());
    });
  }

  const startAccessMutation = useMutation({
    mutationFn: async () => {
      if (!isAuthenticated) {
        await signIn(window.location.href);
        return;
      }

      const response = await createBuyerProductAccessVerificationIntent(catalogProductId, {
        returnTo: accessData.product.accessPagePath,
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
  const hasAccess = accessState.hasActiveEntitlement;
  const isSignedOut = !isViewerPending && !isAuthenticated;
  const packageCount = product.packagePreview.length;
  const packageCountLabel = `${packageCount} Unity package${packageCount === 1 ? '' : 's'}`;
  const heroCopy = isViewerPending
    ? 'Loading your YUCP account so this page can show the right purchase flow.'
    : hasAccess
      ? 'Your purchase is ready. Add the package source to VCC, then install it in Unity.'
      : isAuthenticated
        ? 'Next, confirm the purchase so this YUCP account can unlock the package for VCC.'
        : 'Sign in with the Discord account you use for YUCP. After that, you can verify the purchase and add the package to VCC.';
  const flowNote = isViewerPending
    ? 'Checking whether this purchase is already linked to your account.'
    : hasAccess
      ? 'VCC will open with your private package source.'
      : isAuthenticated
        ? `Confirm the ${product.providerLabel} purchase or enter the license details you received after buying.`
        : 'Start by signing in with your Creator Identity. You will come back here to verify the purchase.';
  const currentStep = isViewerPending ? 0 : hasAccess ? 2 : isAuthenticated ? 1 : 0;
  const isRepoReady = Boolean(repoAccessQuery.data?.addRepoUrl);
  const isRepoPending = hasAccess && repoAccessQuery.isLoading;
  const [isManualSetupOpen, setIsManualSetupOpen] = useState(false);

  if (isViewerPending) {
    return <PageLoadingOverlay />;
  }

  return (
    <PageShell>
      <Card className={`vp-card vp-access-card${isSignedOut ? ' vp-access-card--signed-out' : ''}`}>
        <div className="vp-access-hero">
          <div className="vp-access-summary">
            <h1 className="vp-package-name">{product.displayName}</h1>
            <p className="vp-card-subtitle">{heroCopy}</p>

            <ul className="vp-access-facts" aria-label="Product access details">
              <li className="vp-access-fact">
                <Store className="size-3.5" />
                Purchase source: {product.providerLabel}
              </li>
              <li className="vp-access-fact">
                <Package className="size-3.5" />
                {packageCountLabel}
              </li>
              <li className="vp-access-fact">
                <ShieldCheck className="size-3.5" />
                Private VCC access
              </li>
            </ul>

            {search.intent_id ? (
              <div className="vp-access-callout vp-access-callout--success">
                Purchase confirmed. Continue with VCC below.
              </div>
            ) : null}

            {!accessState.hasPublishedPackages ? (
              <div className="vp-access-callout vp-access-callout--warning">
                This product is linked, but the creator has not published a package yet.
              </div>
            ) : null}
          </div>

          <Card
            className={`vp-access-action-card${isSignedOut ? ' vp-access-action-card--signed-out' : ''}`}
            variant="secondary"
          >
            <Card.Header>
              <Card.Title>
                {isViewerPending
                  ? 'Checking your account'
                  : hasAccess
                    ? 'Add to VCC'
                    : isSignedOut
                      ? 'Sign in to continue'
                      : 'Verify this purchase'}
              </Card.Title>
              <Card.Description>{flowNote}</Card.Description>
            </Card.Header>
            <Card.Content>
              {isViewerPending ? (
                <div className="vp-checking-section">
                  <YucpButton yucp="primary" className="vp-primary-btn w-full" isLoading isDisabled>
                    Checking account...
                  </YucpButton>
                  <p className="vp-section-desc mb-0">
                    The purchase flow will appear once your YUCP session finishes loading.
                  </p>
                </div>
              ) : hasAccess ? (
                <div className="vp-checking-section">
                  <YucpButton
                    yucp="primary"
                    className="vp-primary-btn w-full"
                    isLoading={isRepoPending}
                    isDisabled={!isRepoReady}
                    onPress={() => {
                      if (repoAccessQuery.data?.addRepoUrl) {
                        window.location.href = repoAccessQuery.data.addRepoUrl;
                      }
                    }}
                  >
                    {isRepoPending ? 'Preparing VCC access...' : 'Add to VCC'}
                  </YucpButton>

                  {repoAccessQuery.isError ? (
                    <p className="vp-method-error">
                      We could not prepare your repo handoff. Refresh and try again.
                    </p>
                  ) : !isRepoPending && !isRepoReady ? (
                    <p className="vp-section-desc mb-0">
                      Your purchase is verified, but the VCC button is still being prepared. Refresh
                      this page in a moment.
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className={`vp-oauth-section${isSignedOut ? ' vp-access-signin-panel' : ''}`}>
                  {isSignedOut ? (
                    <div className="vp-signin-flow">
                      <div className="vp-signin-flow-intro">
                        <div className="vp-access-signin-icon">
                          <LogIn className="size-5" />
                        </div>
                        <div>
                          <p className="vp-access-signin-title">
                            Sign in with your Creator Identity
                          </p>
                          <p className="vp-access-signin-copy">
                            Use your Creator Identity in VCC so this purchase links correctly.
                          </p>
                        </div>
                      </div>

                      <YucpButton
                        yucp="primary"
                        className="vp-signin-cta-btn"
                        isLoading={startAccessMutation.isPending}
                        isDisabled={!accessState.hasPublishedPackages || isAuthPending}
                        onPress={() => startAccessMutation.mutate()}
                      >
                        {startAccessMutation.isPending
                          ? 'Starting sign-in...'
                          : 'Sign in to continue'}
                      </YucpButton>
                    </div>
                  ) : null}

                  {!isSignedOut ? (
                    <div className="vp-oauth-row">
                      <div className="vp-oauth-row-left">
                        <KeyRound className="size-5 text-white/70" />
                        <div className="vp-oauth-row-text">
                          <span className="vp-oauth-label">Purchase check</span>
                          <span className="vp-oauth-account">
                            Signed in. Now verify what you bought.
                          </span>
                        </div>
                      </div>
                      <div className="vp-oauth-row-right">
                        <YucpButton
                          yucp="primary"
                          className="vp-oauth-verify-btn"
                          isLoading={startAccessMutation.isPending}
                          isDisabled={!accessState.hasPublishedPackages || isAuthPending}
                          onPress={() => startAccessMutation.mutate()}
                        >
                          {startAccessMutation.isPending
                            ? 'Starting verification...'
                            : 'Verify purchase'}
                        </YucpButton>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </Card.Content>
          </Card>
        </div>

        <Separator className="vp-access-separator" />

        <div className={`vp-access-body${isSignedOut ? ' vp-access-body--signed-out' : ''}`}>
          <section className="vp-access-flow" aria-label="Access flow">
            <div className="vp-section-heading">
              <p className="vp-section-title">{isSignedOut ? 'What happens next' : 'Next steps'}</p>
              <p className="vp-section-desc">
                {isViewerPending
                  ? 'We are checking your account before showing the active step.'
                  : isSignedOut
                    ? 'You only need to do this once for your Creator Identity.'
                    : 'Complete the active step, then continue in Unity.'}
              </p>
            </div>
            <ol className="vp-access-stepper">
              <AccessStep
                index={0}
                currentStep={currentStep}
                title="Sign in"
                description="Choose your Creator Identity in VCC."
              />
              <AccessStep
                index={1}
                currentStep={currentStep}
                title="Confirm your purchase"
                description={`Use the ${product.providerLabel} account or license details from your receipt.`}
              />
              <AccessStep
                index={2}
                currentStep={currentStep}
                title="Add to VCC"
                description="Open VCC with your private package source and install the package."
              />
            </ol>
          </section>

          <div className="vp-content-column">
            <section className="vp-section">
              <div className="vp-section-heading">
                <p className="vp-section-title">
                  {isViewerPending
                    ? 'Included package'
                    : isSignedOut
                      ? 'You will unlock'
                      : `Included package${packageCount === 1 ? '' : 's'}`}
                </p>
                <p className="vp-section-desc">
                  {isViewerPending
                    ? `${packageCountLabel} will be available once your account state finishes loading.`
                    : isSignedOut
                      ? 'After verification, this package source is added privately to your account.'
                      : `${packageCountLabel} will appear after VCC syncs.`}
                </p>
              </div>
              <div className="vp-section-stack">
                {product.packagePreview.map((packageLink) => (
                  <ProductPreview
                    key={packageLink.packageId}
                    packageId={packageLink.packageId}
                    displayName={packageLink.displayName}
                    latestPublishedVersion={packageLink.latestPublishedVersion}
                  />
                ))}
              </div>
            </section>

            {hasAccess ? (
              <Card className="vp-manual-assist-card" variant="secondary">
                <Card.Content className="vp-manual-assist-content">
                  <div className="vp-manual-assist-top">
                    <div className="vp-manual-assist-heading">
                      <h3 className="vp-manual-assist-title">Need help adding to VCC?</h3>
                      <p className="vp-manual-assist-desc">
                        Use <strong>Add to VCC</strong> first. Manual setup is fallback only.
                      </p>
                    </div>
                    {repoAccessQuery.data?.repositoryUrl ? (
                      <YucpButton
                        yucp="ghost"
                        className="vp-manual-setup-toggle"
                        aria-pressed={isManualSetupOpen}
                        onPress={() => setIsManualSetupOpen((value) => !value)}
                      >
                        Manual setup
                        <ChevronDown
                          className={`size-4 vp-manual-setup-toggle-icon${isManualSetupOpen ? ' is-open' : ''}`}
                        />
                      </YucpButton>
                    ) : null}
                  </div>
                  {repoAccessQuery.data?.repositoryUrl ? (
                    <div className="vp-manual-setup-rail">
                      <div
                        className={`vp-manual-setup-panel${isManualSetupOpen ? ' is-open' : ''}`}
                        aria-hidden={!isManualSetupOpen}
                      >
                        <div className="vp-manual-setup">
                          <p className="vp-manual-setup-copy">
                            In VCC, choose <strong>Add Repository</strong>, then paste this private
                            repo URL.
                          </p>
                          <div className="vp-manual-repo-box">
                            <p className="vp-manual-repo-url">
                              {repoAccessQuery.data.repositoryUrl}
                            </p>
                            <YucpButton
                              yucp="ghost"
                              className="vp-manual-repo-copy"
                              onPress={() =>
                                handleCopyValue(
                                  repoAccessQuery.data?.repositoryUrl ?? '',
                                  'Repo URL copied'
                                )
                              }
                            >
                              <Copy className="size-3.5" />
                              Copy
                            </YucpButton>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="vp-section-desc mb-0">
                      If Add to VCC fails, manual repo setup appears here once your handoff is
                      ready.
                    </p>
                  )}
                </Card.Content>
              </Card>
            ) : null}
          </div>
        </div>

        <div className="vp-card-footer">
          <div className="flex flex-wrap items-center justify-center gap-2">
            {isAuthenticated ? (
              <Link to="/account/licenses" className="vp-action-btn">
                Open my purchases
              </Link>
            ) : null}
            {product.storefrontUrl ? (
              <a
                href={product.storefrontUrl}
                target="_blank"
                rel="noreferrer"
                className="vp-action-btn"
              >
                <ExternalLink className="size-4" />
                Open store listing
              </a>
            ) : null}
          </div>
        </div>
      </Card>
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
