import { Stepper } from '@heroui-pro/react/stepper';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import { CloudBackground } from '@/components/three/CloudBackground';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { usePublicAuth } from '@/hooks/usePublicAuth';
import {
  buildProductAccessReturnPath,
  clearProductAccessGrantFromUrl,
  createBuyerProductAccessVerificationIntent,
} from '@/lib/productAccess';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { fetchBuyerProductAccess } from '@/lib/server/productAccess';
import { copyToClipboard } from '@/lib/utils';

export const Route = createFileRoute('/access/$catalogProductId')({
  validateSearch: (search: Record<string, unknown>) => ({
    intent_id: typeof search.intent_id === 'string' ? search.intent_id : undefined,
    grant: typeof search.grant === 'string' ? search.grant : undefined,
  }),
  head: () => ({
    meta: [{ title: 'Product Access | YUCP' }],
    links: routeStylesheetLinks(routeStyleHrefs.verifyPurchase, routeStyleHrefs.productAccess),
  }),
  loader: async ({ params }) =>
    fetchBuyerProductAccess({
      data: { catalogProductId: params.catalogProductId },
    }),
  pendingComponent: PageLoadingOverlay,
  errorComponent: BuyerProductAccessError,
  component: BuyerProductAccessPage,
});

function AccessPageShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="vp-page">
      <CloudBackground variant="default" />
      <div className="vp-wrapper">
        <main className="vp-main vp-main--buyer-access is-visible">{children}</main>
      </div>
    </div>
  );
}

function BuyerProductAccessPage() {
  const { accessState, product, repository } = Route.useLoaderData();
  const search = Route.useSearch();
  const toast = useToast();
  const { isAuthenticated, isPending: isAuthPending, signIn } = usePublicAuth();
  const [isManualSetupOpen, setIsManualSetupOpen] = useState(false);
  const [copyingValue, setCopyingValue] = useState<'add-repo' | 'index' | null>(null);

  useEffect(() => {
    if (search.grant || search.intent_id) clearProductAccessGrantFromUrl();
  }, [search.grant, search.intent_id]);

  const startAccessMutation = useMutation({
    mutationFn: async () => {
      if (!isAuthenticated) {
        await signIn(window.location.href);
        return null;
      }
      return await createBuyerProductAccessVerificationIntent(product.catalogProductId, {
        returnTo: buildProductAccessReturnPath(),
      });
    },
    onSuccess: (intent) => {
      if (intent) window.location.assign(intent.verificationUrl);
    },
    onError: () => {
      toast.error('Could not start verification', {
        description: 'Refresh the page and try again.',
      });
    },
  });

  async function copyRepositoryValue(kind: 'add-repo' | 'index', value: string) {
    setCopyingValue(kind);
    const copied = await copyToClipboard(value);
    setCopyingValue(null);
    if (copied) {
      toast.success(kind === 'index' ? 'Repository URL copied' : 'VCC setup link copied');
    } else {
      toast.error('Could not copy to clipboard');
    }
  }

  if (isAuthPending) return <PageLoadingOverlay />;

  const hasAccess = accessState.hasActiveEntitlement;
  const currentStep = hasAccess ? 2 : isAuthenticated ? 1 : 0;
  const returnedFromVerification = Boolean(search.intent_id && search.grant && hasAccess);
  const providerSummary = Array.from(
    new Set(product.storefronts.map((storefront) => storefront.providerLabel))
  ).join(' + ');
  const providerVisuals = Array.from(
    new Map(product.storefronts.map((storefront) => [storefront.provider, storefront])).values()
  );

  return (
    <AccessPageShell>
      <div className="vp-card vpa-card">
        <header className="vpa-head">
          <div className="vpa-thumb">
            {product.thumbnailUrl ? (
              <img className="vpa-thumb-img" src={product.thumbnailUrl} alt="" />
            ) : (
              <Icon name="package" className="size-7" aria-hidden="true" />
            )}
          </div>
          <div className="vpa-head-text">
            <span className="vpa-provider" title={providerSummary}>
              {providerVisuals.map((storefront) =>
                storefront.providerIcon ? (
                  <img
                    key={storefront.provider}
                    className="vpa-provider-icon"
                    src={`/Icons/${storefront.providerIcon}`}
                    alt={storefront.providerLabel}
                  />
                ) : (
                  <span
                    key={storefront.provider}
                    className="vpa-provider-icon-fallback"
                    role="img"
                    aria-label={storefront.providerLabel}
                  >
                    <Icon name="store" className="size-4" aria-hidden="true" />
                  </span>
                )
              )}
            </span>
            <h1 className="vpa-title">{product.displayName}</h1>
            <p className="vpa-meta">Purchase-verified VCC setup and package delivery</p>
          </div>
        </header>

        <Stepper
          aria-label="Access steps"
          className="vpa-steps"
          currentStep={currentStep}
          orientation="horizontal"
          size="md"
        >
          <Stepper.Step>
            <Stepper.Indicator />
            <Stepper.Content>
              <Stepper.Title>Sign in</Stepper.Title>
            </Stepper.Content>
            <Stepper.Separator />
          </Stepper.Step>
          <Stepper.Step>
            <Stepper.Indicator />
            <Stepper.Content>
              <Stepper.Title>Verify</Stepper.Title>
            </Stepper.Content>
            <Stepper.Separator />
          </Stepper.Step>
          <Stepper.Step>
            <Stepper.Indicator />
            <Stepper.Content>
              <Stepper.Title>Add to VCC</Stepper.Title>
            </Stepper.Content>
            <Stepper.Separator />
          </Stepper.Step>
        </Stepper>

        <section className="vpa-action">
          {returnedFromVerification ? (
            <div className="vpa-callout vpa-callout--success">
              <Icon name="success" className="size-4" aria-hidden="true" />
              Purchase confirmed. Your package access is ready.
            </div>
          ) : null}

          <div>
            <h2 className="vpa-action-title">
              {hasAccess
                ? "You're all set"
                : isAuthenticated
                  ? 'Verify your purchase'
                  : 'Sign in to get started'}
            </h2>
            <p className="vpa-action-desc">
              {hasAccess
                ? 'Add the product to VCC. YUCP then installs the verified files.'
                : isAuthenticated
                  ? `Confirm a purchase from ${providerSummary} to unlock this product.`
                  : 'Use the Creator Identity connected to your purchases and VCC.'}
            </p>
          </div>

          {hasAccess ? (
            <div className="flex flex-wrap gap-2">
              <YucpButton
                yucp="secondary"
                pill
                className="vpa-cta"
                isDisabled={!repository?.addRepoUrl}
                onPress={() => {
                  if (repository?.addRepoUrl) {
                    window.location.assign(repository.addRepoUrl);
                  }
                }}
              >
                <Icon name="externalLink" className="size-4" aria-hidden="true" />
                Add to VCC
              </YucpButton>
            </div>
          ) : (
            <YucpButton
              pill
              className="vpa-cta"
              isLoading={startAccessMutation.isPending}
              onPress={() => startAccessMutation.mutate()}
            >
              {startAccessMutation.isPending
                ? isAuthenticated
                  ? 'Starting verification...'
                  : 'Starting sign-in...'
                : isAuthenticated
                  ? 'Verify purchase'
                  : 'Sign in to continue'}
            </YucpButton>
          )}

          {hasAccess && !repository ? (
            <p className="vpa-note vpa-note--error">
              This creator has not enabled Unity access for this product.
            </p>
          ) : null}
        </section>

        {hasAccess ? (
          <section className="vpa-manual">
            <button
              type="button"
              className="vpa-manual-toggle"
              aria-expanded={isManualSetupOpen}
              onClick={() => setIsManualSetupOpen((current) => !current)}
            >
              Manual setup and troubleshooting
              <Icon
                name="arrowDownLarge"
                className={`vpa-manual-toggle-icon size-4${isManualSetupOpen ? ' is-open' : ''}`}
                aria-hidden="true"
              />
            </button>
            <div
              className={`vpa-manual-panel${isManualSetupOpen ? ' is-open' : ''}`}
              aria-hidden={!isManualSetupOpen}
              inert={!isManualSetupOpen}
            >
              {repository ? (
                <div className="space-y-4">
                  <p className="vpa-manual-copy">
                    Use Add to VCC for the normal flow. These values are available for manual setup
                    or guided support.
                  </p>
                  <p className="vpa-manual-copy">VCC setup link</p>
                  <div className="vpa-repo-box">
                    <p className="vpa-repo-url">{repository.addRepoUrl}</p>
                    <YucpButton
                      yucp="ghost"
                      className="vpa-repo-copy"
                      isLoading={copyingValue === 'add-repo'}
                      onPress={() => void copyRepositoryValue('add-repo', repository.addRepoUrl)}
                    >
                      <Icon name="copy" className="size-3.5" aria-hidden="true" />
                      Copy
                    </YucpButton>
                  </div>
                  <p className="vpa-manual-copy">Package source URL</p>
                  <div className="vpa-repo-box">
                    <p className="vpa-repo-url">{repository.indexUrl}</p>
                    <YucpButton
                      yucp="ghost"
                      className="vpa-repo-copy"
                      isLoading={copyingValue === 'index'}
                      onPress={() => void copyRepositoryValue('index', repository.indexUrl)}
                    >
                      <Icon name="copy" className="size-3.5" aria-hidden="true" />
                      Copy
                    </YucpButton>
                  </div>
                </div>
              ) : (
                <p className="vpa-manual-copy">
                  This creator has not enabled Unity access for this product.
                </p>
              )}
            </div>
          </section>
        ) : null}

        <footer className="vpa-foot">
          {isAuthenticated ? (
            <Link to="/account/licenses" className="vpa-foot-link">
              My purchases
            </Link>
          ) : null}
          {product.storefronts.map((storefront) =>
            storefront.storefrontUrl ? (
              <a
                key={storefront.catalogProductId}
                href={storefront.storefrontUrl}
                target="_blank"
                rel="noreferrer"
                className="vpa-foot-link vpa-store-link"
                aria-label={`${storefront.providerLabel} store`}
                title={`Open ${storefront.providerLabel} store`}
              >
                {storefront.providerIcon ? (
                  <img
                    className="vpa-store-icon"
                    src={`/Icons/${storefront.providerIcon}`}
                    alt=""
                  />
                ) : (
                  <Icon name="externalLink" className="size-4" aria-hidden="true" />
                )}
              </a>
            ) : null
          )}
        </footer>
      </div>
    </AccessPageShell>
  );
}

function BuyerProductAccessError() {
  return (
    <AccessPageShell>
      <div className="vp-card vp-card--error">
        <h1 className="vp-package-name">We could not load this product access page</h1>
        <p className="vp-card-subtitle">
          Open the link again from the store delivery message, then retry.
        </p>
        <div className="mt-6 flex justify-center">
          <Link to="/account/licenses" className="vp-primary-btn">
            Open verified purchases
          </Link>
        </div>
      </div>
    </AccessPageShell>
  );
}
