import { createFileRoute, redirect } from '@tanstack/react-router';
import { PageLoadingOverlay } from '@/components/page/PageLoadingOverlay';
import { normalizeDashboardIdentifier } from '@/lib/dashboard';
import { dashboardShellQueryOptions } from '@/lib/dashboardQueryOptions';
import { primeDashboardShellCaches } from '@/lib/dashboardShellCache';
import {
  addHyperdxActionWithNumbers,
  captureHyperdxException,
  startHyperdxBrowserSpan,
} from '@/lib/hyperdx';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { type DashboardShellData, fetchDashboardShell } from '@/lib/server/dashboard';

/**
 * Client-side cache for dashboard shell data, keyed by "guildId|tenantId".
 * Prevents the route loader from re-running fetchDashboardShell (a server
 * function = HTTP round-trip) on every tab switch within /dashboard/*.
 * The loader still runs on first visit and whenever guild/tenant changes.
 */
const dashboardLoaderCache = new Map<string, DashboardShellData>();

export function clearDashboardLoaderCache() {
  dashboardLoaderCache.clear();
}

interface DashboardSearch {
  guild_id?: string;
  tenant_id?: string;
  setup_token?: string;
  connect_token?: string;
}

export const Route = createFileRoute('/_authenticated/dashboard')({
  ssr: 'data-only',
  head: () => ({
    links: routeStylesheetLinks(
      routeStyleHrefs.dashboard,
      routeStyleHrefs.dashboardComponents,
      routeStyleHrefs.account
    ),
  }),
  validateSearch: (search: Record<string, unknown>): DashboardSearch => ({
    guild_id: normalizeDashboardIdentifier(search.guild_id as string | undefined),
    tenant_id: normalizeDashboardIdentifier(search.tenant_id as string | undefined),
    setup_token: typeof search.setup_token === 'string' ? search.setup_token : undefined,
    connect_token: typeof search.connect_token === 'string' ? search.connect_token : undefined,
  }),
  loaderDeps: ({ search }) => ({
    guildId: search.guild_id ?? null,
    tenantId: search.tenant_id ?? null,
  }),
  staleTime: Infinity,
  pendingComponent: DashboardLayoutPending,
  loader: async ({ context: { queryClient }, location }) => {
    const locationHref = String(location.href);
    const parsedLocation = new URL(locationHref, 'http://dashboard.local');
    const selectedGuildId = normalizeDashboardIdentifier(
      parsedLocation.searchParams.get('guild_id')
    );
    const selectedTenantId = normalizeDashboardIdentifier(
      parsedLocation.searchParams.get('tenant_id')
    );

    const cacheKey = `${selectedGuildId ?? ''}|${selectedTenantId ?? ''}`;
    const isBrowser = typeof window !== 'undefined';
    const cacheHit = isBrowser && dashboardLoaderCache.has(cacheKey);
    const loaderStartedAt = isBrowser ? performance.now() : 0;
    const loaderSpan = isBrowser
      ? startHyperdxBrowserSpan('dashboard.loader', {
          route: '/dashboard',
          cacheHit,
          hasGuildId: Boolean(selectedGuildId),
          hasTenantId: Boolean(selectedTenantId),
        })
      : null;

    if (typeof window !== 'undefined' && dashboardLoaderCache.has(cacheKey)) {
      const durationMs = Number((performance.now() - loaderStartedAt).toFixed(1));
      addHyperdxActionWithNumbers('dashboard.loader.completed', {
        route: '/dashboard',
        cacheHit: true,
        durationMs,
        hasGuildId: Boolean(selectedGuildId),
        hasTenantId: Boolean(selectedTenantId),
      });
      loaderSpan?.end({
        cacheHit: true,
        durationMs,
      });
      return dashboardLoaderCache.get(cacheKey) as DashboardShellData;
    }

    try {
      const shell = await queryClient.ensureQueryData(
        dashboardShellQueryOptions({
          queryKey: ['dashboard-shell', 'route', selectedGuildId ?? null, selectedTenantId ?? null],
          queryFn: () =>
            fetchDashboardShell({
              data: {
                authUserId: selectedTenantId,
                guildId: selectedGuildId,
                includeHomeData: true,
              },
            }),
        })
      );
      primeDashboardShellCaches(queryClient, shell);
      const locationHash = String(location.hash ?? '');
      const allowsFreshGuildBootstrap =
        locationHref.includes('guild_id=') ||
        locationHref.includes('setup_token=') ||
        locationHref.includes('connect_token=') ||
        locationHash.includes('s=') ||
        locationHash.includes('token=');
      if (shell.guilds.length === 0 && !allowsFreshGuildBootstrap) {
        throw redirect({ to: '/account' });
      }
      if (typeof window !== 'undefined') {
        dashboardLoaderCache.set(cacheKey, shell);
      }

      if (isBrowser) {
        const durationMs = Number((performance.now() - loaderStartedAt).toFixed(1));
        addHyperdxActionWithNumbers('dashboard.loader.completed', {
          route: '/dashboard',
          cacheHit: false,
          durationMs,
          guildCount: shell.guilds.length,
          hasGuildId: Boolean(selectedGuildId),
          hasTenantId: Boolean(selectedTenantId),
        });
        loaderSpan?.end({
          cacheHit: false,
          durationMs,
          guildCount: shell.guilds.length,
        });
      }

      return shell;
    } catch (error) {
      if (isBrowser) {
        const durationMs = Number((performance.now() - loaderStartedAt).toFixed(1));
        addHyperdxActionWithNumbers('dashboard.loader.failed', {
          route: '/dashboard',
          cacheHit,
          durationMs,
          hasGuildId: Boolean(selectedGuildId),
          hasTenantId: Boolean(selectedTenantId),
        });
        captureHyperdxException(error, {
          route: '/dashboard',
          stage: 'route-loader',
          cacheHit,
        });
        loaderSpan?.fail(error, {
          cacheHit,
          durationMs,
        });
      }

      throw error;
    }
  },
});

function DashboardLayoutPending() {
  return <PageLoadingOverlay />;
}
