import { Button, Card } from '@heroui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Copy, ExternalLink, LogIn, Package, ShieldCheck, Store } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CloudBackground } from '@/components/three/CloudBackground';
import { usePublicAuth } from '@/hooks/usePublicAuth';
import {
  createBuyerBackstageVerificationIntent,
  getBuyerBackstageAccessInfo,
  requestUserBackstageRepoAccess,
} from '@/lib/backstageAccess';

export const Route = createFileRoute('/get-in-unity/$creatorRef/$productRef')({
  validateSearch: (search: Record<string, unknown>) => ({
    grant: typeof search.grant === 'string' ? search.grant : undefined,
    intent_id: typeof search.intent_id === 'string' ? search.intent_id : undefined,
  }),
  component: BuyerUnityAccessPage,
});

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return Array.from(value, (part) => part.toString(16).padStart(2, '0')).join('');
}

async function sha256Base64Url(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = Array.from(new Uint8Array(hash), (byte) => String.fromCharCode(byte)).join('');
  return btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildReturnUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('grant');
  url.searchParams.delete('intent_id');
  return url.toString();
}

function BuyerUnityAccessPage() {
  const { creatorRef, productRef } = Route.useParams();
  const { grant } = Route.useSearch();
  const { isAuthenticated, isPending: isAuthPending, signIn } = usePublicAuth();
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  const accessQuery = useQuery({
    queryKey: ['buyer-backstage-access', creatorRef, productRef],
    queryFn: () => getBuyerBackstageAccessInfo({ creatorRef, productRef }),
    retry: false,
  });

  const repoAccessQuery = useQuery({
    queryKey: ['buyer-backstage-repo-access', grant],
    queryFn: requestUserBackstageRepoAccess,
    enabled: isAuthenticated && Boolean(grant),
    retry: false,
  });

  const bootstrapMutation = useMutation({
    mutationFn: async () => {
      const machineFingerprint = `buyer-web-${randomHex(16)}`;
      const codeVerifier = `${randomHex(32)}${randomHex(32)}`;
      const codeChallenge = await sha256Base64Url(codeVerifier);
      return await createBuyerBackstageVerificationIntent({
        creatorRef,
        productRef,
        returnUrl: buildReturnUrl(window.location.href),
        machineFingerprint,
        codeChallenge,
        idempotencyKey: `buyer-access:${creatorRef}:${productRef}`,
      });
    },
    onSuccess: ({ verificationUrl }) => {
      window.location.assign(verificationUrl);
    },
  });

  const packageSummary = useMemo(() => {
    if (!accessQuery.data) {
      return '';
    }
    if (accessQuery.data.packageSummaries.length === 0) {
      return 'No Unity packages are published for this product yet.';
    }
    if (accessQuery.data.packageSummaries.length === 1) {
      const pkg = accessQuery.data.packageSummaries[0];
      return `${pkg.displayName ?? pkg.packageId}${pkg.latestPublishedVersion ? ` · ${pkg.latestPublishedVersion}` : ''}`;
    }
    return `${accessQuery.data.packageSummaries.length} Unity packages will appear in VCC after verification.`;
  }, [accessQuery.data]);

  const handleCopy = async (value: string, message: string) => {
    await navigator.clipboard.writeText(value);
    setCopyMessage(message);
    window.setTimeout(
      () => setCopyMessage((current) => (current === message ? null : current)),
      2500
    );
  };

  const handlePrimaryAction = async () => {
    if (!isAuthenticated) {
      await signIn(window.location.href);
      return;
    }
    bootstrapMutation.mutate();
  };

  return (
    <div className="min-h-screen bg-transparent">
      <CloudBackground variant="default" />
      <main className="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-4 py-10">
        <Card className="w-full max-w-3xl rounded-[28px] border border-white/12 bg-white/8 shadow-none backdrop-blur-xl dark:border-white/10 dark:bg-white/6">
          <Card.Content className="space-y-6 p-6 md:p-8">
            {accessQuery.isPending ? (
              <div className="space-y-3 text-center">
                <p className="text-sm font-medium text-foreground/75">Preparing Unity access</p>
                <p className="text-foreground/65">Loading the product this link points to.</p>
              </div>
            ) : accessQuery.isError || !accessQuery.data ? (
              <div className="space-y-3 text-center">
                <p className="text-sm font-medium text-foreground/75">Link not available</p>
                <h1 className="text-2xl font-semibold text-foreground">
                  This Unity access link is not valid
                </h1>
                <p className="text-foreground/65">
                  Ask the creator for a fresh Unity access link for this product.
                </p>
              </div>
            ) : grant ? (
              <div className="space-y-6">
                <div className="space-y-3 text-center">
                  <div className="mx-auto flex size-14 items-center justify-center rounded-full border border-emerald-400/35 bg-emerald-400/12 text-emerald-200">
                    <ShieldCheck className="size-7" />
                  </div>
                  <p className="text-sm font-medium text-foreground/75">Purchase verified</p>
                  <h1 className="text-3xl font-semibold text-foreground">
                    {accessQuery.data.title}
                  </h1>
                  <p className="mx-auto max-w-2xl text-sm text-foreground/70">
                    You&apos;re signed in and verified. Add your private repo to VCC to see the
                    Unity packages you own.
                  </p>
                </div>

                <div className="grid gap-3 rounded-2xl border border-white/12 bg-white/7 p-4 dark:border-white/10 dark:bg-white/5 md:grid-cols-3">
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-foreground/45">
                      Creator
                    </p>
                    <p className="text-sm text-foreground">
                      {accessQuery.data.creatorName ?? accessQuery.data.creatorRepoRef}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-foreground/45">
                      Store
                    </p>
                    <p className="text-sm text-foreground">{accessQuery.data.provider}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-foreground/45">
                      What unlocks
                    </p>
                    <p className="text-sm text-foreground">{packageSummary}</p>
                  </div>
                </div>

                {repoAccessQuery.isPending ? (
                  <p className="text-center text-sm text-foreground/65">
                    Preparing your VCC link...
                  </p>
                ) : repoAccessQuery.isError || !repoAccessQuery.data ? (
                  <p className="rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
                    We verified your purchase, but we couldn&apos;t prepare the VCC repo link yet.
                    Refresh and try again.
                  </p>
                ) : (
                  <div className="space-y-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-center">
                      <Button
                        size="lg"
                        variant="outline"
                        onPress={() => window.location.assign(repoAccessQuery.data.addRepoUrl)}
                      >
                        <ExternalLink className="size-4" />
                        Add to VCC
                      </Button>
                      <Button
                        size="lg"
                        variant="ghost"
                        onPress={() =>
                          handleCopy(repoAccessQuery.data.repositoryUrl, 'Repo link copied')
                        }
                      >
                        <Copy className="size-4" />
                        Copy repo link
                      </Button>
                    </div>
                    <details className="rounded-2xl border border-white/12 bg-white/7 p-4 text-sm dark:border-white/10 dark:bg-white/5">
                      <summary className="cursor-pointer font-medium text-foreground">
                        Manual setup and troubleshooting
                      </summary>
                      <div className="mt-3 space-y-2 text-foreground/70">
                        <p>Use this if VCC does not open automatically from the main button.</p>
                        <p className="break-all rounded-xl border border-white/10 bg-black/10 px-3 py-2 font-mono text-xs text-foreground/80">
                          {repoAccessQuery.data.repositoryUrl}
                        </p>
                        <p className="text-xs text-foreground/55">
                          This repo view is private to your account and only shows packages you own.
                        </p>
                      </div>
                    </details>
                    {copyMessage ? (
                      <p className="text-center text-xs font-medium text-foreground/55">
                        {copyMessage}
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex flex-col gap-5 md:flex-row md:items-start">
                  <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-3xl border border-white/14 bg-white/8 dark:border-white/10 dark:bg-white/6">
                    {accessQuery.data.thumbnailUrl ? (
                      <img
                        src={accessQuery.data.thumbnailUrl}
                        alt=""
                        aria-hidden="true"
                        className="size-full object-cover"
                      />
                    ) : (
                      <Store className="size-8 text-foreground/70" />
                    )}
                  </div>
                  <div className="min-w-0 space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-foreground/45">
                      Get in Unity
                    </p>
                    <h1 className="text-3xl font-semibold text-foreground">
                      {accessQuery.data.title}
                    </h1>
                    <p className="max-w-2xl text-sm leading-7 text-foreground/70">
                      Sign in with the account that bought this product. YUCP will verify your
                      purchase, then give you one private <strong>Add to VCC</strong> action for the
                      Unity packages you own.
                    </p>
                    <div className="flex flex-wrap gap-2 text-xs text-foreground/55">
                      <span className="inline-flex items-center gap-1 rounded-full border border-white/12 px-3 py-1">
                        <ShieldCheck className="size-3.5" />
                        Private and per account
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-white/12 px-3 py-1">
                        <Package className="size-3.5" />
                        {packageSummary}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 rounded-2xl border border-white/12 bg-white/7 p-4 dark:border-white/10 dark:bg-white/5 md:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-foreground/45">
                      Creator
                    </p>
                    <p className="text-sm text-foreground">
                      {accessQuery.data.creatorName ?? accessQuery.data.creatorRepoRef}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-foreground/45">
                      Store
                    </p>
                    <p className="text-sm capitalize text-foreground">
                      {accessQuery.data.provider}
                    </p>
                  </div>
                </div>

                {!accessQuery.data.ready ? (
                  <p className="rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
                    This product exists, but the creator has not published a Unity package for it
                    yet.
                  </p>
                ) : (
                  <div className="space-y-3">
                    <Button
                      size="lg"
                      variant="outline"
                      isDisabled={isAuthPending || bootstrapMutation.isPending}
                      onPress={() => {
                        void handlePrimaryAction();
                      }}
                    >
                      {bootstrapMutation.isPending ? (
                        <>
                          <span className="btn-loading-spinner" aria-hidden="true" />
                          Starting verification...
                        </>
                      ) : isAuthenticated ? (
                        <>
                          <ShieldCheck className="size-4" />
                          Verify purchase
                        </>
                      ) : (
                        <>
                          <LogIn className="size-4" />
                          Sign in to continue
                        </>
                      )}
                    </Button>
                    <p className="text-sm text-foreground/55">
                      Nothing installs yet. This only verifies your purchase and prepares your
                      private VCC repo access.
                    </p>
                  </div>
                )}
              </div>
            )}
          </Card.Content>
        </Card>
      </main>
    </div>
  );
}
