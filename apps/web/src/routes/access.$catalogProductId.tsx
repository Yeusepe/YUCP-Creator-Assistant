import { createFileRoute } from '@tanstack/react-router';
import { Copy, Download, ExternalLink, Package, PackagePlus, Store } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import { CloudBackground } from '@/components/three/CloudBackground';
import { YucpButton } from '@/components/ui/YucpButton';
import { type BuyerVpmRepositoryAccess, mintBuyerVpmRepository } from '@/lib/productAccess';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { fetchBuyerProductAccess } from '@/lib/server/productAccess';
import { copyToClipboard } from '@/lib/utils';

export const Route = createFileRoute('/access/$catalogProductId')({
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
  const { accessState, product } = Route.useLoaderData();
  const downloadPath = `/api/access/${encodeURIComponent(product.catalogProductId)}/download`;

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
            <p className="vpa-meta">Purchase-protected download</p>
          </div>
        </header>

        <section className="vpa-action">
          <div>
            <h2 className="vpa-action-title">
              {accessState.hasActiveEntitlement ? 'Your download is ready' : 'Verify your purchase'}
            </h2>
            <p className="vpa-action-desc">
              {accessState.hasActiveEntitlement
                ? 'The download link is signed when you open it and expires after five minutes.'
                : 'Open your verified purchases to confirm access before downloading.'}
            </p>
          </div>

          <a
            className="vp-primary-btn vpa-cta"
            href={accessState.hasActiveEntitlement ? downloadPath : '/account/licenses'}
          >
            {accessState.hasActiveEntitlement ? (
              <Download className="size-4" aria-hidden="true" />
            ) : null}
            {accessState.hasActiveEntitlement ? 'Download' : 'Open verified purchases'}
          </a>
        </section>

        {accessState.hasActiveEntitlement ? <BuyerVpmAccess /> : null}

        {product.storefrontUrl ? (
          <footer className="vpa-foot">
            <a
              href={product.storefrontUrl}
              target="_blank"
              rel="noreferrer"
              className="vpa-foot-link"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              Store listing
            </a>
          </footer>
        ) : null}
      </div>
    </AccessPageShell>
  );
}

function BuyerVpmAccess() {
  const [repository, setRepository] = useState<BuyerVpmRepositoryAccess | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function prepareRepository() {
    setIsPending(true);
    setError(null);
    try {
      setRepository(await mintBuyerVpmRepository());
    } catch {
      setError('We could not prepare your VPM repository. Try again in a moment.');
    } finally {
      setIsPending(false);
    }
  }

  if (!repository) {
    return (
      <section className="vpa-manual" aria-label="Unity Creator Companion access">
        <h2 className="vpa-action-title">Install in Unity</h2>
        <p className="vpa-manual-copy">
          Create your private package source, then add it to VRChat Creator Companion.
        </p>
        <YucpButton
          yucp="secondary"
          className="vpa-cta"
          isLoading={isPending}
          onPress={() => prepareRepository()}
        >
          <PackagePlus className="size-4" aria-hidden="true" />
          {isPending ? 'Preparing VPM repo...' : 'Get VPM repo'}
        </YucpButton>
        {error ? <p className="vpa-note vpa-note--error">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className="vpa-manual" aria-label="Unity Creator Companion access">
      <h2 className="vpa-action-title">Your private VPM repository</h2>
      <p className="vpa-manual-copy">
        Add the source to VCC, or copy the index URL for manual repository setup.
      </p>
      <a className="vp-primary-btn vpa-cta" href={repository.addRepoUrl}>
        <PackagePlus className="size-4" aria-hidden="true" />
        Add to VCC
      </a>
      <p className="vpa-manual-copy">VCC add-repo URL</p>
      <div className="vpa-repo-box">
        <p className="vpa-repo-url">{repository.addRepoUrl}</p>
      </div>
      <p className="vpa-manual-copy">Repository index URL</p>
      <div className="vpa-repo-box">
        <p className="vpa-repo-url">{repository.indexUrl}</p>
        <YucpButton
          yucp="ghost"
          className="vpa-repo-copy"
          aria-label="Copy index URL"
          onPress={() => copyToClipboard(repository.indexUrl)}
        >
          <Copy className="size-3.5" aria-hidden="true" />
          Copy
        </YucpButton>
      </div>
    </section>
  );
}

function BuyerProductAccessError() {
  return (
    <AccessPageShell>
      <div className="vp-card vp-card--error">
        <h1 className="vp-package-name">We could not load this product</h1>
        <p className="vp-card-subtitle">Open the access link again, then retry.</p>
      </div>
    </AccessPageShell>
  );
}
