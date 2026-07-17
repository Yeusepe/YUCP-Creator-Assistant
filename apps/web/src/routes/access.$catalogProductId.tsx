import { createFileRoute } from '@tanstack/react-router';
import { Download, ExternalLink, Package, Store } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import { CloudBackground } from '@/components/three/CloudBackground';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { fetchBuyerProductAccess } from '@/lib/server/productAccess';

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
