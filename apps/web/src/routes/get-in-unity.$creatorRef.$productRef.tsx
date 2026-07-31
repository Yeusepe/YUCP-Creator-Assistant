import { createFileRoute } from '@tanstack/react-router';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import {
  BuyerProductAccessError,
  BuyerProductAccessView,
} from '@/components/productAccess/BuyerProductAccessView';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { fetchBuyerProductAccess } from '@/lib/server/productAccess';

export const Route = createFileRoute('/get-in-unity/$creatorRef/$productRef')({
  validateSearch: (search: Record<string, unknown>) => ({
    grant: typeof search.grant === 'string' ? search.grant : undefined,
    from: search.from === 'signin' ? ('signin' as const) : undefined,
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
  pendingComponent: PageLoadingOverlay,
  errorComponent: BuyerProductAccessError,
  component: BuyerUnityAccessPage,
});

function BuyerUnityAccessPage() {
  return <BuyerProductAccessView access={Route.useLoaderData()} search={Route.useSearch()} />;
}
