import { Card, Skeleton } from '@heroui/react';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { CloudBackground } from '@/components/three/CloudBackground';
import { Icon } from '@/components/ui/Icon';
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

export const Route = createFileRoute('/get-in-unity/$creatorRef/$productRef')({
  validateSearch: (search: Record<string, unknown>) => ({
    grant: typeof search.grant === 'string' ? search.grant : undefined,
    intent_id: typeof search.intent_id === 'string' ? search.intent_id : undefined,
  }),
  head: () => ({
    meta: [{ title: 'Get in Unity | YUCP' }],
    links: routeStylesheetLinks(routeStyleHrefs.verifyPurchase, routeStyleHrefs.productAccess),
  }),
  loader: async ({ params }) =>
    fetchBuyerProductAccess({
      data: { catalogProductId: params.productRef, creatorRef: params.creatorRef },
    }),
  pendingComponent: BuyerUnityAccessPending,
  errorComponent: BuyerUnityAccessError,
  component: BuyerUnityAccessPage,
});

function BuyerUnityAccessPage() {
  const { accessState, product, repository } = Route.useLoaderData();
  const search = Route.useSearch();
  const { isAuthenticated, isPending: isAuthPending, signIn } = usePublicAuth();
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [isCopying, setIsCopying] = useState(false);

  useEffect(() => {
    if (search.grant || search.intent_id) clearProductAccessGrantFromUrl();
  }, [search.grant, search.intent_id]);

  const bootstrapMutation = useMutation({
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
  });

  async function copyVccLink() {
    if (!repository) return;
    setIsCopying(true);
    const copied = await copyToClipboard(repository.addRepoUrl);
    setIsCopying(false);
    setCopyMessage(copied ? 'VCC setup link copied' : 'Could not copy the VCC setup link');
  }

  const hasAccess = accessState.hasActiveEntitlement;
  const returnedVerified = Boolean(search.grant && search.intent_id && hasAccess);
  const providerSummary = Array.from(
    new Set(product.storefronts.map((storefront) => storefront.providerLabel))
  ).join(' + ');

  return (
    <div className="min-h-screen bg-transparent dark:bg-transparent">
      <CloudBackground variant="default" />
      <main className="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-4 py-10">
        <Card className="w-full max-w-3xl rounded-[28px] border border-slate-300/60 bg-white/80 shadow-none backdrop-blur-xl dark:border-white/10 dark:bg-white/6">
          <Card.Content className="space-y-6 p-6 md:p-8">
            {hasAccess ? (
              <div className="space-y-6">
                <div className="space-y-3 text-center">
                  <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/35 dark:bg-emerald-400/12 dark:text-emerald-200">
                    <Icon name="shield" className="size-7" aria-hidden="true" />
                  </div>
                  <p className="text-sm font-medium text-slate-600 dark:text-foreground/75">
                    {returnedVerified ? 'Purchase verified' : 'Package access ready'}
                  </p>
                  <h1 className="text-3xl font-semibold text-slate-950 dark:text-foreground">
                    {product.displayName}
                  </h1>
                  <p className="mx-auto max-w-2xl text-sm text-slate-600 dark:text-foreground/70">
                    Add this product to VCC. The importer checks access and installs its files.
                  </p>
                </div>

                <div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-white/10 dark:bg-white/5 md:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-foreground/45">
                      Store
                    </p>
                    <p className="text-sm text-slate-950 dark:text-foreground">{providerSummary}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-foreground/45">
                      Access
                    </p>
                    <p className="text-sm text-slate-950 dark:text-foreground">
                      Verified VCC setup and importer delivery
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-center">
                  <YucpButton
                    yucp="secondary"
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
                  {repository ? (
                    <YucpButton
                      yucp="ghost"
                      isLoading={isCopying}
                      onPress={() => void copyVccLink()}
                    >
                      <Icon name="copy" className="size-4" aria-hidden="true" />
                      {isCopying ? 'Copying...' : 'Copy VCC setup link'}
                    </YucpButton>
                  ) : null}
                </div>

                {repository ? (
                  <details className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 text-sm dark:border-white/10 dark:bg-white/5">
                    <summary className="cursor-pointer font-medium text-slate-950 dark:text-foreground">
                      Manual setup and troubleshooting
                    </summary>
                    <div className="mt-3 space-y-2 text-slate-600 dark:text-foreground/70">
                      <p>Use this package source URL if VCC does not open from the main button.</p>
                      <p className="break-all rounded-xl border border-slate-200 bg-white/80 px-3 py-2 font-mono text-xs text-slate-800 dark:border-white/10 dark:bg-black/10 dark:text-foreground/80">
                        {repository.indexUrl}
                      </p>
                    </div>
                  </details>
                ) : (
                  <div className="rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-danger/30 dark:bg-danger/10 dark:text-danger">
                    This creator has not enabled Unity access for this product.
                  </div>
                )}

                {copyMessage ? (
                  <p className="text-center text-xs font-medium text-slate-500 dark:text-foreground/55">
                    {copyMessage}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex flex-col gap-5 md:flex-row md:items-start">
                  <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-3xl border border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/6">
                    {product.thumbnailUrl ? (
                      <img
                        src={product.thumbnailUrl}
                        alt=""
                        aria-hidden="true"
                        className="size-full object-cover"
                      />
                    ) : (
                      <Icon
                        name="store"
                        className="size-8 text-slate-600 dark:text-foreground/70"
                      />
                    )}
                  </div>
                  <div className="min-w-0 space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-foreground/45">
                      Get in Unity
                    </p>
                    <h1 className="text-3xl font-semibold text-slate-950 dark:text-foreground">
                      {product.displayName}
                    </h1>
                    <p className="max-w-2xl text-sm leading-7 text-slate-600 dark:text-foreground/70">
                      Sign in with the account that bought this product. YUCP verifies the purchase,
                      then prepares VCC and download access.
                    </p>
                    <div className="flex flex-wrap gap-2 text-xs text-slate-600 dark:text-foreground/55">
                      <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-3 py-1 dark:border-white/12">
                        <Icon name="shield" className="size-3.5" aria-hidden="true" />
                        Verified for this account
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-3 py-1 dark:border-white/12">
                        <Icon name="package" className="size-3.5" aria-hidden="true" />
                        Unity Creator Companion ready
                      </span>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-white/10 dark:bg-white/5 md:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-foreground/45">
                      Store
                    </p>
                    <p className="text-sm text-slate-950 dark:text-foreground">{providerSummary}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-foreground/45">
                      Product access
                    </p>
                    <p className="text-sm text-slate-950 dark:text-foreground">
                      Purchase verification required
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <YucpButton
                    yucp="secondary"
                    isLoading={isAuthPending || bootstrapMutation.isPending}
                    onPress={() => bootstrapMutation.mutate()}
                  >
                    {isAuthenticated ? (
                      <Icon name="shield" className="size-4" aria-hidden="true" />
                    ) : (
                      <Icon name="login" className="size-4" aria-hidden="true" />
                    )}
                    {bootstrapMutation.isPending
                      ? isAuthenticated
                        ? 'Starting verification...'
                        : 'Starting sign-in...'
                      : isAuthenticated
                        ? 'Verify purchase'
                        : 'Sign in to continue'}
                  </YucpButton>
                  <p className="text-sm text-slate-500 dark:text-foreground/55">
                    Nothing installs yet. This action only starts the secure purchase check.
                  </p>
                  {bootstrapMutation.isError ? (
                    <p className="rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-danger/30 dark:bg-danger/10 dark:text-danger">
                      Verification could not be started. Refresh and try again.
                    </p>
                  ) : null}
                </div>
              </div>
            )}
          </Card.Content>
        </Card>
      </main>
    </div>
  );
}

function BuyerUnityAccessPending() {
  return (
    <div className="min-h-screen bg-transparent dark:bg-transparent">
      <CloudBackground variant="default" />
      <main className="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-4 py-10">
        <Card
          className="w-full max-w-3xl rounded-[28px] border border-slate-300/60 bg-white/80 shadow-none backdrop-blur-xl dark:border-white/10 dark:bg-white/6"
          aria-label="Loading Unity access"
        >
          <Card.Content className="space-y-6 p-6 md:p-8">
            <div className="flex flex-col gap-5 md:flex-row">
              <Skeleton className="size-20 shrink-0 rounded-3xl" />
              <div className="flex-1 space-y-3">
                <Skeleton className="h-3 w-28 rounded" />
                <Skeleton className="h-8 w-3/5 rounded" />
                <Skeleton className="h-4 w-full rounded" />
                <Skeleton className="h-4 w-4/5 rounded" />
              </div>
            </div>
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-11 w-48 rounded-xl" />
          </Card.Content>
        </Card>
      </main>
    </div>
  );
}

function BuyerUnityAccessError() {
  return (
    <div className="min-h-screen bg-transparent dark:bg-transparent">
      <CloudBackground variant="default" />
      <main className="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-4 py-10">
        <Card className="w-full max-w-xl rounded-[28px] border border-red-200 bg-white/85 shadow-none backdrop-blur-xl dark:border-danger/30 dark:bg-white/6">
          <Card.Content className="space-y-3 p-8 text-center">
            <p className="text-sm font-medium text-red-700 dark:text-danger">Link not available</p>
            <h1 className="text-2xl font-semibold text-slate-950 dark:text-foreground">
              This Unity access link is not valid
            </h1>
            <p className="text-slate-600 dark:text-foreground/65">
              Ask the creator for a fresh product access link.
            </p>
          </Card.Content>
        </Card>
      </main>
    </div>
  );
}
