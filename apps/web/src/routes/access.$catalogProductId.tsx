import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { CloudBackground } from '@/components/three/CloudBackground';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { useAuth } from '@/hooks/useAuth';
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
  const { isAuthenticated, isPending: isAuthPending, signIn } = useAuth();
  const [isStartingVerification, setIsStartingVerification] = useState(false);

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
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
              YUCP product access
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 dark:text-white sm:text-4xl">
              {product.displayName}
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-600 dark:text-slate-300 sm:text-base">
              {hasAccess
                ? 'Your YUCP account already has access to this product. Add the repo in VCC to start installing packages.'
                : 'Sign in with the YUCP account you want to use in VCC, then verify the store account or license you purchased with.'}
            </p>

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

            <div className="mt-6 flex flex-wrap gap-3">
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

            <div className="mt-8 space-y-4">
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-white">
                  What happens on this page
                </p>
                <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                  <li>1. Sign in to the YUCP account where you want access to live.</li>
                  <li>2. Confirm the purchase on the store account you actually used.</li>
                  <li>3. Use Add to VCC to open the buyer-specific repo handoff.</li>
                </ul>
              </div>

              <details className="rounded-2xl border border-black/10 bg-white/70 p-4 dark:border-white/10 dark:bg-white/5">
                <summary className="cursor-pointer list-none text-sm font-semibold text-slate-900 dark:text-white">
                  Manual setup and troubleshooting
                </summary>
                <div className="mt-4 space-y-3 text-sm text-slate-600 dark:text-slate-300">
                  <p>
                    If VCC does not open automatically, use Add Repository in VCC and paste the repo
                    URL below.
                  </p>
                  {repoAccessQuery.data?.repositoryUrl ? (
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
                  ) : (
                    <p>Verify first, then the manual repo details will appear here.</p>
                  )}
                </div>
              </details>
            </div>
          </section>

          <aside className="space-y-4">
            <section className="rounded-[28px] border border-black/10 bg-white/80 p-5 shadow-xl backdrop-blur dark:border-white/10 dark:bg-slate-900/85">
              <p className="text-sm font-semibold text-slate-900 dark:text-white">
                Package preview
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                These are the install IDs that will show up once this account has access.
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
                  className="btn-ghost mt-4 inline-flex items-center justify-center rounded-full px-4 py-2"
                >
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
