import { Stepper } from '@heroui-pro/react/stepper';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { getSafeLoopbackRedirectTarget } from '@yucp/shared/authRedirects';
import { type ReactNode, useEffect, useRef, useState } from 'react';
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
import type { BuyerProductAccessResponse } from '@/lib/productAccessTypes';
import { copyToClipboard } from '@/lib/utils';
import { logWebError } from '@/lib/webDiagnostics';

interface BuyerProductAccessViewProps {
  access: BuyerProductAccessResponse;
  search: {
    from?: 'signin';
    grant?: string;
    intent_id?: string;
    return_to?: string;
  };
}

/** Sign-in returns here, so the page has to know it was not opened directly. */
function buildSignInReturnUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.set('from', 'signin');
  return url.toString();
}

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

export function BuyerProductAccessView({ access, search }: BuyerProductAccessViewProps) {
  const { accessState, product, repository } = access;
  const toast = useToast();
  const { isAuthenticated, isPending: isAuthPending, signIn } = usePublicAuth();
  const [isManualSetupOpen, setIsManualSetupOpen] = useState(false);
  const [copyingValue, setCopyingValue] = useState<'add-repo' | 'index' | null>(null);
  // The importer opens this page with its own loopback listener attached. Verification then
  // ends on the broker's page, which is what lets it raise the Unity window, so the buyer is
  // never sent on to VCC setup that the importer does not need.
  const brokerReturnUrl = getSafeLoopbackRedirectTarget(search.return_to);

  useEffect(() => {
    if (search.grant || search.intent_id) clearProductAccessGrantFromUrl();
  }, [search.grant, search.intent_id]);

  const startAccessMutation = useMutation({
    mutationFn: async () => {
      if (!isAuthenticated) {
        await signIn(buildSignInReturnUrl());
        return null;
      }
      return await createBuyerProductAccessVerificationIntent(product.catalogProductId, {
        returnTo: brokerReturnUrl ?? buildProductAccessReturnPath(),
      });
    },
    onSuccess: (intent) => {
      if (intent) window.location.assign(intent.verificationUrl);
    },
    onError: () => {
      toast.error('We couldn’t start verification', {
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
      toast.error('We couldn’t copy that link');
    }
  }

  const hasAccess = accessState.hasActiveEntitlement;
  const cameFromSignIn = search.from === 'signin';

  // Better Auth's reactive session is the source of truth for whether this browser
  // has an active signed-in session. A buyer returning from sign-in or arriving
  // from the native broker can therefore proceed directly to the app-owned
  // verification intent instead of stopping on a redundant handoff button.
  // https://better-auth.com/docs/concepts/session-management#use-session
  const hasForwardedToVerification = useRef(false);
  const startAccess = startAccessMutation.mutate;
  useEffect(() => {
    if ((!cameFromSignIn && !brokerReturnUrl) || !isAuthenticated || hasAccess) return;
    if (hasForwardedToVerification.current) return;
    hasForwardedToVerification.current = true;
    startAccess();
  }, [brokerReturnUrl, cameFromSignIn, hasAccess, isAuthenticated, startAccess]);

  if (isAuthPending) return <PageLoadingOverlay />;

  const currentStep = hasAccess ? 2 : isAuthenticated ? 1 : 0;
  const returnedFromVerification = Boolean(search.intent_id && search.grant && hasAccess);
  // Unity sent them here; the VCC already has the repository, so handing back a
  // vcc:// link would bounce them into the wrong application.
  const returnsToUnity = hasAccess && (cameFromSignIn || returnedFromVerification);
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
            <p className="vpa-meta">Verify your purchase, then install in Unity</p>
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
              <Stepper.Title>
                {returnsToUnity || brokerReturnUrl ? 'Back to Unity' : 'Add to VCC'}
              </Stepper.Title>
            </Stepper.Content>
            <Stepper.Separator />
          </Stepper.Step>
        </Stepper>

        <section className="vpa-action">
          {returnedFromVerification ? (
            <div className="vpa-callout vpa-callout--success">
              <Icon name="success" className="size-4" aria-hidden="true" />
              Purchase confirmed. You can install this product in Unity.
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
              {returnsToUnity
                ? 'Switch back to the Unity importer window to finish installing.'
                : hasAccess
                  ? 'Add the product to VCC. It will install the files for you.'
                  : isAuthenticated
                    ? `Confirm a purchase from ${providerSummary} to install this product.`
                    : 'Use the Creator Identity connected to your purchases and VCC.'}
            </p>
          </div>

          {returnsToUnity ? (
            <div className="vpa-callout">
              <Icon name="success" className="size-4" aria-hidden="true" />
              You can close this tab and return to Unity.
            </div>
          ) : hasAccess ? (
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
              This product is not available to install in Unity yet.
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
                  <p className="vpa-manual-copy">Product source URL</p>
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
                  This product is not available to install in Unity yet.
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

export function BuyerProductAccessError({ error }: { error?: Error }) {
  if (error) {
    logWebError('Buyer product access route error', error, {
      phase: 'buyer-product-access-error-boundary',
    });
  }

  return (
    <AccessPageShell>
      <div className="vp-card vp-card--error">
        <h1 className="vp-package-name">We couldn’t load this product</h1>
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
