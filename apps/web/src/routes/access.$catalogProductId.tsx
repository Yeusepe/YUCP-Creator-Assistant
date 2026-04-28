import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ChevronDown, ChevronUp, ExternalLink, Package, ShieldCheck, Store } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CloudBackground } from '@/components/three/CloudBackground';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { usePublicAuth } from '@/hooks/usePublicAuth';
import { requestBackstageRepoAccess } from '@/lib/packages';
import {
  createBuyerProductAccessVerificationIntent,
  getBuyerProductAccess,
} from '@/lib/productAccess';

export const Route = createFileRoute('/access/$catalogProductId')({
  validateSearch: (search: Record<string, unknown>) => ({
    intent_id: typeof search.intent_id === 'string' ? search.intent_id : undefined,
    grant: typeof search.grant === 'string' ? search.grant : undefined,
  }),
  head: () => ({
    meta: [{ title: 'Product Access | YUCP' }],
  }),
  component: BuyerProductAccessPage,
});

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
    <div className="rounded-2xl border border-black/10 bg-white/70 p-4 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
      <p className="text-sm font-semibold text-slate-900 dark:text-white">
        {displayName ?? packageId}
      </p>
      <p className="mt-1 break-all font-mono text-xs text-slate-600 dark:text-slate-300">
        {packageId}
      </p>
      <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
        {latestPublishedVersion
          ? `Latest version ${latestPublishedVersion}`
          : 'Waiting for first live version'}
      </p>
    </div>
  );
}

function BuyerProductAccessPage() {
  const { catalogProductId } = Route.useParams();
  const search = Route.useSearch();
  const toast = useToast();
  const { isAuthenticated, isPending: isAuthPending, signIn } = usePublicAuth();
  const [isStartingVerification, setIsStartingVerification] = useState(false);
  const [isManualSetupOpen, setIsManualSetupOpen] = useState(false);

  useEffect(() => {
    if (!search.grant || typeof window === 'undefined') {
      return;
    }

    const url = new URL(window.location.href);
    url.searchParams.delete('grant');
    window.history.replaceState({}, '', url.toString());
  }, [search.grant]);

  const accessQuery = useQuery({
    queryKey: ['buyer-product-access', catalogProductId],
    queryFn: () => getBuyerProductAccess(catalogProductId),
  });

  const repoAccessQuery = useQuery({
    queryKey: ['buyer-backstage-repo-access', catalogProductId],
    queryFn: requestBackstageRepoAccess,
    enabled:
      isAuthenticated &&
      accessQuery.data?.accessState.hasActiveEntitlement === true &&
      accessQuery.data.accessState.hasPublishedPackages,
    retry: false,
  });

  useEffect(() => {
    if (!repoAccessQuery.data?.repositoryUrl) {
      setIsManualSetupOpen(false);
    }
  }, [repoAccessQuery.data?.repositoryUrl]);

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

  if (accessQuery.isLoading) {
    return (
      <div className="min-h-screen bg-slate-100 dark:bg-slate-950">
        <CloudBackground variant="default" />
        <main className="mx-auto flex min-h-screen max-w-5xl items-center px-4 py-16">
          <div className="w-full rounded-[28px] border border-black/10 bg-white/75 p-8 shadow-xl backdrop-blur dark:border-white/10 dark:bg-slate-900/80">
            <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
              Loading product access...
            </p>
          </div>
        </main>
      </div>
    );
  }

  if (accessQuery.isError || !accessQuery.data) {
    return (
      <div className="min-h-screen bg-slate-100 dark:bg-slate-950">
        <CloudBackground variant="default" />
        <main className="mx-auto flex min-h-screen max-w-5xl items-center px-4 py-16">
          <div className="w-full rounded-[28px] border border-rose-200 bg-white/85 p-8 shadow-xl backdrop-blur dark:border-rose-500/40 dark:bg-slate-900/90">
            <p className="text-sm font-semibold text-rose-700 dark:text-rose-300">
              We could not load this product access page.
            </p>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              Open the link again from your store receipt or your library, then try once more.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                to="/account/licenses"
                className="btn-ghost inline-flex items-center justify-center"
              >
                Open verified purchases
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const { product, accessState } = accessQuery.data;
  const hasAccess = accessState.hasActiveEntitlement;
  const packageCount = product.packagePreview.length;
  const packageCountLabel = `${packageCount} Unity package${packageCount === 1 ? '' : 's'}`;
  const productSummary = packageCount
    ? `This purchase unlocks ${packageCountLabel.toLowerCase()} for your YUCP account.`
    : 'This purchase will unlock your Unity package access once publishing is ready.';
  const primaryAction = hasAccess
    ? 'Add to VCC'
    : isAuthenticated
      ? 'Verify purchase'
      : 'Sign in to continue';

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-950">
      <CloudBackground variant="default" />
      <main className="mx-auto flex min-h-screen max-w-5xl items-center px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.9fr)]">
          <section className="rounded-[32px] border border-black/10 bg-white/80 p-6 shadow-xl backdrop-blur dark:border-white/10 dark:bg-slate-900/85 sm:p-8">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
              <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-[24px] border border-black/10 bg-slate-50 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
                {product.thumbnailUrl ? (
                  <img
                    src={product.thumbnailUrl}
                    alt=""
                    aria-hidden="true"
                    className="size-full object-cover"
                  />
                ) : (
                  <Store className="size-8 text-slate-500 dark:text-slate-300" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                  Buyer access
                </p>
                <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 dark:text-white sm:text-4xl">
                  {product.displayName}
                </h1>
                <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-600 dark:text-slate-300 sm:text-base">
                  {hasAccess
                    ? 'This YUCP account already owns access. Use one Add to VCC action to open your private repo, then install the packages you own in Unity.'
                    : 'Sign in with the YUCP account you want to use in VCC, then verify the store account or license you purchased with.'}
                </p>
                <div className="mt-4 flex flex-wrap gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <span className="inline-flex items-center gap-1 rounded-full border border-black/10 bg-white px-3 py-1 dark:border-white/10 dark:bg-white/5">
                    <Store className="size-3.5" />
                    Bought on {product.providerLabel}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-black/10 bg-white px-3 py-1 dark:border-white/10 dark:bg-white/5">
                    <Package className="size-3.5" />
                    {packageCountLabel}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-black/10 bg-white px-3 py-1 dark:border-white/10 dark:bg-white/5">
                    <ShieldCheck className="size-3.5" />
                    Private per account
                  </span>
                </div>
              </div>
            </div>

            {search.intent_id ? (
              <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
                Purchase confirmed. VCC comes next.
              </div>
            ) : null}

            {!accessState.hasPublishedPackages ? (
              <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                This product is linked, but the creator has not published a package yet.
              </div>
            ) : null}

            <div className="mt-8 rounded-[28px] border border-black/10 bg-slate-50/80 p-5 shadow-sm dark:border-white/10 dark:bg-slate-950/45 sm:p-6">
              <p className="text-sm font-semibold text-slate-900 dark:text-white">
                {hasAccess ? 'Add this product to VCC' : 'Unlock this product in VCC'}
              </p>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">
                {hasAccess
                  ? 'Use the main button to open your entitled YUCP repo in VCC. Advanced repo details stay hidden unless you need a manual setup path.'
                  : 'This flow only verifies ownership and prepares your private VCC repo. Nothing installs until you finish the Add to VCC step.'}
              </p>

              <div className="mt-5 flex flex-wrap gap-3">
                {hasAccess ? (
                  <YucpButton
                    yucp="primary"
                    pill
                    isLoading={repoAccessQuery.isLoading}
                    isDisabled={!repoAccessQuery.data?.addRepoUrl}
                    onPress={() => {
                      if (repoAccessQuery.data?.addRepoUrl) {
                        window.location.href = repoAccessQuery.data.addRepoUrl;
                      }
                    }}
                  >
                    {repoAccessQuery.isLoading ? 'Preparing VCC...' : primaryAction}
                  </YucpButton>
                ) : (
                  <YucpButton
                    yucp="primary"
                    pill
                    isLoading={isStartingVerification}
                    isDisabled={!accessState.hasPublishedPackages || isAuthPending}
                    onPress={async () => {
                      if (!isAuthenticated) {
                        await signIn(window.location.href);
                        return;
                      }

                      try {
                        setIsStartingVerification(true);
                        const response = await createBuyerProductAccessVerificationIntent(
                          catalogProductId,
                          {
                            returnTo: product.accessPagePath,
                          }
                        );
                        window.location.href = response.verificationUrl;
                      } catch {
                        toast.error('Could not start verification', {
                          description: 'Please refresh and try again.',
                        });
                        setIsStartingVerification(false);
                      }
                    }}
                  >
                    {isStartingVerification ? 'Starting verification...' : primaryAction}
                  </YucpButton>
                )}

                <Link
                  to="/account/licenses"
                  className="btn-ghost inline-flex items-center justify-center rounded-full px-5 py-2.5"
                >
                  Open verified purchases
                </Link>
              </div>

              {repoAccessQuery.isError ? (
                <p className="mt-4 text-sm text-rose-700 dark:text-rose-300">
                  We could not prepare your repo handoff. Refresh the page and try again.
                </p>
              ) : null}

              {hasAccess ? (
                <div className="mt-5 rounded-2xl border border-black/10 bg-white/80 p-4 dark:border-white/10 dark:bg-white/5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-slate-900 dark:text-white">
                        Need the manual repo path?
                      </p>
                      <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
                        Keep using Add to VCC for the normal flow. Only open manual setup if VCC
                        does not launch or support asks for the repo URL.
                      </p>
                    </div>
                    <YucpButton
                      yucp="ghost"
                      isDisabled={!repoAccessQuery.data?.repositoryUrl}
                      onPress={() => setIsManualSetupOpen((current) => !current)}
                    >
                      {isManualSetupOpen ? (
                        <>
                          <ChevronUp className="size-4" />
                          Hide manual setup
                        </>
                      ) : (
                        <>
                          <ChevronDown className="size-4" />
                          Show manual setup
                        </>
                      )}
                    </YucpButton>
                  </div>

                  {!repoAccessQuery.data?.repositoryUrl ? (
                    <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                      Manual repo details appear after your private repo handoff is ready.
                    </p>
                  ) : null}

                  {isManualSetupOpen && repoAccessQuery.data?.repositoryUrl ? (
                    <div className="mt-4 space-y-3 text-sm text-slate-600 dark:text-slate-300">
                      <p>
                        In VCC, choose <strong>Add Repository</strong> and paste the entitled repo
                        URL below.
                      </p>
                      <div className="rounded-2xl border border-black/10 bg-slate-50 p-3 dark:border-white/10 dark:bg-slate-950/60">
                        <p className="break-all font-mono text-xs text-slate-700 dark:text-slate-200">
                          {repoAccessQuery.data.repositoryUrl}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <YucpButton
                            yucp="ghost"
                            onPress={() =>
                              handleCopyValue(
                                repoAccessQuery.data?.repositoryUrl ?? '',
                                'Repo URL copied'
                              )
                            }
                          >
                            Copy repo URL
                          </YucpButton>
                        </div>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        This repo stays private to your YUCP account and only contains packages you
                        own.
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="mt-5 text-sm text-slate-500 dark:text-slate-400">
                  Manual repo setup stays hidden until this account has verified access.
                </p>
              )}
            </div>

            <div className="mt-8 space-y-4">
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-white">
                  What you get on this page
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {productSummary}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-black/10 bg-white/70 p-4 dark:border-white/10 dark:bg-white/5">
                  <p className="text-sm font-semibold text-slate-900 dark:text-white">
                    1. Use one YUCP account
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                    Sign in to the YUCP account where you want this purchase to live in VCC.
                  </p>
                </div>
                <div className="rounded-2xl border border-black/10 bg-white/70 p-4 dark:border-white/10 dark:bg-white/5">
                  <p className="text-sm font-semibold text-slate-900 dark:text-white">
                    2. Verify the purchase
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                    Confirm the store account or license you originally used on{' '}
                    {product.providerLabel}.
                  </p>
                </div>
                <div className="rounded-2xl border border-black/10 bg-white/70 p-4 dark:border-white/10 dark:bg-white/5">
                  <p className="text-sm font-semibold text-slate-900 dark:text-white">
                    3. Add the entitled repo
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                    Open one private repo handoff in VCC, then install the packages this product
                    unlocks.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <aside className="space-y-4">
            <section className="rounded-[28px] border border-black/10 bg-white/80 p-5 shadow-xl backdrop-blur dark:border-white/10 dark:bg-slate-900/85">
              <p className="text-sm font-semibold text-slate-900 dark:text-white">
                Owned product context
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                This is the storefront purchase that maps to your VCC access for this buyer account.
              </p>
              <div className="mt-4 grid gap-3 rounded-2xl border border-black/10 bg-white/70 p-4 dark:border-white/10 dark:bg-white/5">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                    Product
                  </p>
                  <p className="mt-1 text-sm font-medium text-slate-900 dark:text-white">
                    {product.displayName}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                    Store
                  </p>
                  <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                    {product.providerLabel}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                    Unlocks
                  </p>
                  <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                    {packageCountLabel}
                  </p>
                </div>
              </div>
            </section>

            <section className="rounded-[28px] border border-black/10 bg-white/80 p-5 shadow-xl backdrop-blur dark:border-white/10 dark:bg-slate-900/85">
              <p className="text-sm font-semibold text-slate-900 dark:text-white">
                Included packages
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                These install IDs show up in VCC after this buyer account gets access.
              </p>
              <div className="mt-4 space-y-3">
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

            <section className="rounded-[28px] border border-black/10 bg-white/80 p-5 shadow-xl backdrop-blur dark:border-white/10 dark:bg-slate-900/85">
              <p className="text-sm font-semibold text-slate-900 dark:text-white">
                Need to reopen this later?
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                Use the same YUCP access button from the store page or open your Verified purchases
                page in account settings.
              </p>
              {product.storefrontUrl ? (
                <a
                  href={product.storefrontUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-ghost mt-4 inline-flex items-center justify-center gap-2 rounded-full px-4 py-2"
                >
                  <ExternalLink className="size-4" />
                  Open store listing
                </a>
              ) : null}
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
