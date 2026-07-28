import { createFileRoute } from '@tanstack/react-router';
import {
  BuyerProductAccessError,
  BuyerProductAccessView,
} from '@/components/productAccess/BuyerProductAccessView';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { fetchBuyerProductAccess } from '@/lib/server/productAccess';

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

function BuyerProductAccessPage() {
  return <BuyerProductAccessView access={Route.useLoaderData()} search={Route.useSearch()} />;
}
