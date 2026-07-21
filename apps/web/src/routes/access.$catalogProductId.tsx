import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import {
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  Package,
  Store,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import { CloudBackground } from '@/components/three/CloudBackground';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { usePublicAuth } from '@/hooks/usePublicAuth';
import {
  buildProductAccessReturnPath,
  createBuyerProductAccessVerificationIntent,
  mintBuyerVpmRepository,
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

function BuyerProductAccessPage() {
  const { accessState, product } = Route.useLoaderData();
  const search = Route.useSearch();
  const toast = useToast();
  const { isAuthenticated, isPending: isAuthPending, signIn } = usePublicAuth();
  const [isManualSetupOpen, setIsManualSetupOpen] = useState(false);
  const [copyingValue, setCopyingValue] = useState<'add-repo' | 'index' | null>(null);
  const downloadPath = `/api/access/${encodeURIComponent(product.catalogProductId)}/download`;

  const repositoryQuery = useQuery({
    queryKey: ['buyer-vpm-repository', product.catalogProductId],
    queryFn: mintBuyerVpmRepository,
    enabled: isAuthenticated && accessState.hasActiveEntitlement,
    retry: false,
  });

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

  return (
    <AccessPageShell>
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
              <Store className="size-3.5" aria-hidden="true" />
              {product.providerLabel}
            </span>
            <h1 className="vpa-title">{product.displayName}</h1>
            <p className="vpa-meta">Private VCC access and protected downloads</p>
          </div>
        </header>

        <ol className="vpa-steps" aria-label="Access steps">
          <ProgressStep index={0} currentStep={currentStep} label="Sign in" />
          <ProgressStep index={1} currentStep={currentStep} label="Verify" />
          <ProgressStep index={2} currentStep={currentStep} label="Add to VCC" />
        </ol>

        <section className="vpa-action">
          {returnedFromVerification ? (
            <div className="vpa-callout vpa-callout--success">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Purchase confirmed. Your private package access is ready.
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
                ? 'Download the package directly or add your private source to VCC.'
                : isAuthenticated
                  ? `Confirm your ${product.providerLabel} purchase to unlock this product.`
                  : 'Use the Creator Identity connected to your purchases and VCC.'}
            </p>
          </div>

          {hasAccess ? (
            <div className="flex flex-wrap gap-2">
              <a className="vp-primary-btn vpa-cta" href={downloadPath}>
                <Download className="size-4" aria-hidden="true" />
                Download
              </a>
              <YucpButton
                yucp="secondary"
                pill
                className="vpa-cta"
                isLoading={repositoryQuery.isPending}
                isDisabled={!repositoryQuery.data?.addRepoUrl}
                onPress={() => {
                  if (repositoryQuery.data?.addRepoUrl) {
                    window.location.assign(repositoryQuery.data.addRepoUrl);
                  }
                }}
              >
                <ExternalLink className="size-4" aria-hidden="true" />
                {repositoryQuery.isPending ? 'Preparing VCC access...' : 'Add to VCC'}
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

          {repositoryQuery.isError ? (
            <p className="vpa-note vpa-note--error">
              Your purchase is active, but the VPM repository could not be prepared. Retry below.
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
              <ChevronDown
                className={`vpa-manual-toggle-icon size-4${isManualSetupOpen ? ' is-open' : ''}`}
                aria-hidden="true"
              />
            </button>
            <div
              className={`vpa-manual-panel${isManualSetupOpen ? ' is-open' : ''}`}
              aria-hidden={!isManualSetupOpen}
              inert={!isManualSetupOpen}
            >
              {repositoryQuery.isError ? (
                <YucpButton
                  yucp="secondary"
                  isLoading={repositoryQuery.isFetching}
                  onPress={() => void repositoryQuery.refetch()}
                >
                  Retry VPM access
                </YucpButton>
              ) : repositoryQuery.data ? (
                <div className="space-y-4">
                  <p className="vpa-manual-copy">
                    Use Add to VCC for the normal flow. These values are available for manual setup
                    or guided support.
                  </p>
                  <p className="vpa-manual-copy">VCC add-repo URL</p>
                  <div className="vpa-repo-box">
                    <p className="vpa-repo-url">{repositoryQuery.data.addRepoUrl}</p>
                    <YucpButton
                      yucp="ghost"
                      className="vpa-repo-copy"
                      isLoading={copyingValue === 'add-repo'}
                      onPress={() =>
                        void copyRepositoryValue('add-repo', repositoryQuery.data.addRepoUrl)
                      }
                    >
                      <Copy className="size-3.5" aria-hidden="true" />
                      Copy
                    </YucpButton>
                  </div>
                  <p className="vpa-manual-copy">Repository index URL</p>
                  <div className="vpa-repo-box">
                    <p className="vpa-repo-url">{repositoryQuery.data.indexUrl}</p>
                    <YucpButton
                      yucp="ghost"
                      className="vpa-repo-copy"
                      isLoading={copyingValue === 'index'}
                      onPress={() =>
                        void copyRepositoryValue('index', repositoryQuery.data.indexUrl)
                      }
                    >
                      <Copy className="size-3.5" aria-hidden="true" />
                      Copy
                    </YucpButton>
                  </div>
                </div>
              ) : (
                <p className="vpa-manual-copy">Preparing your private repository details.</p>
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
          {product.storefrontUrl ? (
            <a
              href={product.storefrontUrl}
              target="_blank"
              rel="noreferrer"
              className="vpa-foot-link"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              Store listing
            </a>
          ) : null}
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
