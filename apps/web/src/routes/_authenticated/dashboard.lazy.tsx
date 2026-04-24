import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createLazyFileRoute, Link, Outlet, useNavigate } from '@tanstack/react-router';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiClient } from '@/api/client';
import { DashboardBodyPortal } from '@/components/dashboard/DashboardBodyPortal';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { CloudBackground } from '@/components/three/CloudBackground';
import { useAuth } from '@/hooks/useAuth';
import { DashboardSessionProvider, useDashboardSession } from '@/hooks/useDashboardSession';
import { useDashboardShell } from '@/hooks/useDashboardShell';
import { ServerContextProvider } from '@/hooks/useServerContext';
import { listCreatorCertificates } from '@/lib/certificates';
import {
  addHyperdxActionWithNumbers,
  buildHyperdxNavigationPhases,
  getHyperdxNavigationSnapshot,
  getHyperdxSlowestNavigationPhase,
  recordHyperdxNavigationTrace,
} from '@/lib/hyperdx';
import { type Guild } from '@/lib/server/dashboard';
import { getServerIconUrl } from '@/lib/utils';
import { BILLING_CAPABILITY_KEYS } from '../../../../../convex/lib/billingCapabilities';
import { clearDashboardLoaderCache } from './dashboard';

export const Route = createLazyFileRoute('/_authenticated/dashboard')({
  component: DashboardLayout,
  errorComponent: DashboardRouteErrorComponent,
});

type PendingDashboardGuild = { id: string } & Partial<Pick<Guild, 'icon' | 'name' | 'tenantId'>>;

type DashboardBootstrapState =
  | {
      status: 'idle';
      setupToken?: undefined;
      connectToken?: undefined;
      pendingGuild?: undefined;
    }
  | {
      status: 'checking';
      setupToken?: undefined;
      connectToken?: undefined;
      pendingGuild?: PendingDashboardGuild;
    }
  | {
      status: 'bootstrapping';
      setupToken?: string;
      connectToken?: string;
      pendingGuild?: PendingDashboardGuild;
    };

function buildDashboardLocation(args: {
  guildId?: string;
  tenantId?: string;
  setupToken?: string;
  connectToken?: string;
  path?: string;
}) {
  if (typeof window === 'undefined') return '/dashboard';

  const currentPath =
    args.path ??
    (window.location.pathname === '/dashboard' || window.location.pathname.startsWith('/dashboard/')
      ? window.location.pathname
      : '/dashboard');
  const dashboardUrl = new URL(currentPath, window.location.origin);
  if (args.guildId) {
    dashboardUrl.searchParams.set('guild_id', args.guildId);
  }
  if (args.tenantId) {
    dashboardUrl.searchParams.set('tenant_id', args.tenantId);
  }

  const hash = new URLSearchParams({
    ...(args.setupToken ? { s: args.setupToken } : {}),
    ...(args.connectToken ? { token: args.connectToken } : {}),
  }).toString();
  if (hash) {
    dashboardUrl.hash = hash;
  }

  return `${dashboardUrl.pathname}${dashboardUrl.search}${dashboardUrl.hash}`;
}

function redirectToExpiredLinkError() {
  if (typeof window === 'undefined') return;

  const errorUrl = new URL('/verify-error', window.location.origin);
  errorUrl.searchParams.set('error', 'link_expired');
  window.location.replace(errorUrl.toString());
}

function redirectToDashboardSignIn(args: {
  guildId?: string;
  tenantId?: string;
  setupToken?: string;
  connectToken?: string;
  path?: string;
}) {
  if (typeof window === 'undefined') return;

  window.location.assign(
    `/sign-in-redirect?redirectTo=${encodeURIComponent(buildDashboardLocation(args))}`
  );
}

function DashboardLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  const navigationRecordedRef = useRef(false);
  const { guild_id, tenant_id } = search;
  const { selectedGuild } = useDashboardShell();
  const shouldCheckBootstrap = Boolean(guild_id && !tenant_id && !selectedGuild);
  const [bootstrapState, setBootstrapState] = useState<DashboardBootstrapState>(() =>
    search.setup_token || search.connect_token
      ? {
          status: 'bootstrapping',
          setupToken: search.setup_token,
          connectToken: search.connect_token,
          pendingGuild: guild_id ? { id: guild_id, tenantId: tenant_id } : undefined,
        }
      : shouldCheckBootstrap && guild_id
        ? {
            status: 'checking',
            pendingGuild: { id: guild_id, tenantId: tenant_id },
          }
        : { status: 'idle' }
  );
  const hasBootstrapPending = bootstrapState.status !== 'idle';
  const pendingGuild = bootstrapState.pendingGuild;
  const displayGuild = selectedGuild ?? pendingGuild;
  const resolvedGuildId = displayGuild?.id ?? guild_id;
  const resolvedTenantId = displayGuild?.tenantId ?? tenant_id;
  const isPersonalDashboard = !resolvedGuildId;

  useEffect(() => {
    if (navigationRecordedRef.current || typeof window === 'undefined') {
      return;
    }

    const snapshot = getHyperdxNavigationSnapshot();
    if (!snapshot || window.location.pathname !== '/dashboard') {
      return;
    }

    navigationRecordedRef.current = true;

    const phases = buildHyperdxNavigationPhases(snapshot);
    const slowestPhase = getHyperdxSlowestNavigationPhase(phases);
    addHyperdxActionWithNumbers('dashboard.navigation.breakdown', {
      route: '/dashboard',
      navigationType: snapshot.navigationType,
      totalMs: snapshot.totalMs,
      redirectMs: snapshot.redirectMs,
      dnsMs: snapshot.dnsMs,
      connectionMs: snapshot.connectionMs,
      requestSentMs: snapshot.requestSentMs,
      serverWaitMs: snapshot.serverWaitMs,
      responseDownloadMs: snapshot.responseDownloadMs,
      browserProcessingMs: snapshot.browserProcessingMs,
      domInteractiveMs: snapshot.domInteractiveMs,
      domContentLoadedMs: snapshot.domContentLoadedMs,
      loadEventEndMs: snapshot.loadEventEndMs,
      transferSize: snapshot.transferSize,
      encodedBodySize: snapshot.encodedBodySize,
      decodedBodySize: snapshot.decodedBodySize,
      phaseCount: phases.length,
      slowestPhase: slowestPhase?.name,
      slowestPhaseMs: slowestPhase?.durationMs,
    });

    for (const phase of phases) {
      addHyperdxActionWithNumbers('dashboard.navigation.phase', {
        route: '/dashboard',
        navigationType: snapshot.navigationType,
        phase: phase.name,
        startMs: phase.startMs,
        endMs: phase.endMs,
        durationMs: phase.durationMs,
      });
    }

    for (const metric of snapshot.serverTiming) {
      addHyperdxActionWithNumbers('dashboard.navigation.server_timing', {
        route: '/dashboard',
        stage: metric.name,
        durationMs: metric.durationMs,
      });
    }

    recordHyperdxNavigationTrace('dashboard.navigation.document', phases, {
      route: '/dashboard',
      navigationType: snapshot.navigationType,
      totalMs: snapshot.totalMs,
      slowestPhase: slowestPhase?.name,
      slowestPhaseMs: slowestPhase?.durationMs,
    });
  }, []);

  useEffect(() => {
    if (search.setup_token || search.connect_token) {
      setBootstrapState((current) => {
        if (
          current.status === 'bootstrapping' &&
          current.setupToken === search.setup_token &&
          current.connectToken === search.connect_token
        ) {
          return current;
        }

        return {
          status: 'bootstrapping',
          setupToken: search.setup_token,
          connectToken: search.connect_token,
          pendingGuild:
            current.pendingGuild ?? (guild_id ? { id: guild_id, tenantId: tenant_id } : undefined),
        };
      });
      return;
    }

    if (shouldCheckBootstrap && guild_id) {
      setBootstrapState((current) => {
        if (current.status !== 'idle') {
          return current;
        }

        return {
          status: 'checking',
          pendingGuild: { id: guild_id, tenantId: tenant_id },
        };
      });
      return;
    }

    setBootstrapState((current) => (current.status === 'checking' ? { status: 'idle' } : current));
  }, [guild_id, search.connect_token, search.setup_token, shouldCheckBootstrap, tenant_id]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const setupToken = search.setup_token ?? hashParams.get('s') ?? undefined;
    const connectToken = search.connect_token ?? hashParams.get('token') ?? undefined;
    if (!setupToken && !connectToken) {
      if (bootstrapState.status === 'checking') {
        setBootstrapState({ status: 'idle' });
      }
      return;
    }

    setBootstrapState((current) => {
      if (
        current.status === 'bootstrapping' &&
        current.setupToken === setupToken &&
        current.connectToken === connectToken
      ) {
        return current;
      }

      return {
        status: 'bootstrapping',
        setupToken,
        connectToken,
        pendingGuild:
          current.pendingGuild ?? (guild_id ? { id: guild_id, tenantId: tenant_id } : undefined),
      };
    });
  }, [bootstrapState.status, guild_id, search.connect_token, search.setup_token, tenant_id]);

  useEffect(() => {
    if (bootstrapState.status !== 'bootstrapping' || typeof window === 'undefined') {
      return;
    }

    let cancelled = false;
    const { setupToken, connectToken } = bootstrapState;

    async function bootstrapDashboardSetup() {
      try {
        const response = await fetch('/api/connect/bootstrap', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            setupToken,
            connectToken,
          }),
        });

        if (!response.ok) {
          redirectToExpiredLinkError();
          return;
        }

        let nextTenantId = tenant_id;
        if (guild_id) {
          try {
            const data = await apiClient.get<{ authUserId?: string }>(
              '/api/connect/ensure-tenant',
              {
                params: { guildId: guild_id },
              }
            );
            nextTenantId = data.authUserId ?? nextTenantId;
          } catch (error) {
            if (error instanceof ApiError && error.status === 401) {
              redirectToDashboardSignIn({
                guildId: guild_id,
                tenantId: tenant_id,
                setupToken,
                connectToken,
                path:
                  typeof window !== 'undefined' &&
                  window.location.pathname.startsWith('/dashboard/')
                    ? window.location.pathname
                    : undefined,
              });
              return;
            }
            throw error;
          }
        }

        if (cancelled) {
          return;
        }

        queryClient.removeQueries({ queryKey: ['dashboard-shell'] });
        clearDashboardLoaderCache();
        const nextDashboardPath =
          typeof window !== 'undefined' && window.location.pathname === '/dashboard/setup'
            ? '/dashboard/setup'
            : '/dashboard';
        await navigate({
          to: nextDashboardPath,
          search: {
            guild_id,
            tenant_id: nextTenantId,
            setup_token: undefined,
            connect_token: undefined,
          },
          hash: '',
          replace: true,
        });
        if (cancelled) {
          return;
        }

        setBootstrapState({ status: 'idle' });
      } catch (error) {
        console.error('Failed to bootstrap dashboard setup:', error);
        redirectToExpiredLinkError();
      }
    }

    void bootstrapDashboardSetup();

    return () => {
      cancelled = true;
    };
  }, [bootstrapState, guild_id, navigate, queryClient, tenant_id]);

  // Toggle body class for CSS personal/server visibility
  useEffect(() => {
    if (!isPersonalDashboard) {
      document.body.classList.add('state-server-selected');
    } else {
      document.body.classList.remove('state-server-selected');
    }
    return () => document.body.classList.remove('state-server-selected');
  }, [isPersonalDashboard]);

  return (
    <ServerContextProvider guildId={resolvedGuildId} tenantId={resolvedTenantId}>
      <DashboardSessionProvider>
        <div className="dashboard-page">
          <CloudBackground variant="default" />
          <div className="app-shell">
            <SidebarOverlay />
            <ServerDropdownBackdrop />
            <Sidebar hasBootstrapPending={hasBootstrapPending} pendingGuild={pendingGuild} />
            {bootstrapState.status === 'bootstrapping' ? (
              <DashboardBootstrapState pendingGuild={displayGuild} />
            ) : (
              <MainContent pendingGuild={pendingGuild} />
            )}
          </div>
        </div>
      </DashboardSessionProvider>
    </ServerContextProvider>
  );
}

function DashboardBootstrapState({ pendingGuild }: { pendingGuild?: PendingDashboardGuild }) {
  return (
    <main className="content-area">
      <DotMatrixBackground />
      <div className="content-area-inner">
        <section className="section-card bento-col-12 p-6 sm:p-7 md:p-8">
          <div className="content-header-eyebrow">Server Setup</div>
          <h1 className="content-header-title">
            {pendingGuild?.name ? `Linking ${pendingGuild.name}` : 'Linking your server'}
          </h1>
          <p className="content-header-desc">
            Finalizing the server link and loading the dashboard.
          </p>
        </section>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/*  Sidebar Overlay                                                    */
/* ------------------------------------------------------------------ */

function SidebarOverlay() {
  return (
    <div
      id="sidebar-overlay"
      className="sidebar-overlay"
      aria-hidden="true"
      onClick={toggleSidebarGlobal}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Server Dropdown Backdrop                                           */
/* ------------------------------------------------------------------ */

function ServerDropdownBackdrop() {
  return (
    <div id="server-dropdown-backdrop" className="server-dropdown-backdrop" aria-hidden="true" />
  );
}

/* ------------------------------------------------------------------ */
/*  Global sidebar toggle (mirrors original JS)                        */
/* ------------------------------------------------------------------ */

function toggleSidebarGlobal() {
  if (typeof document === 'undefined') return;
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar && overlay) {
    const isOpen = sidebar.classList.toggle('is-open');
    if (isOpen) {
      overlay.classList.add('is-visible');
    } else {
      overlay.classList.remove('is-visible');
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Sidebar                                                            */
/* ------------------------------------------------------------------ */

function Sidebar({
  hasBootstrapPending,
  pendingGuild,
}: {
  hasBootstrapPending: boolean;
  pendingGuild?: PendingDashboardGuild;
}) {
  const { guild_id } = Route.useSearch();
  const _isPersonalDashboard = !guild_id;
  const { canRunPanelQueries } = useDashboardSession();

  const certificatesQuery = useQuery({
    queryKey: ['creator-certificates'],
    queryFn: listCreatorCertificates,
    enabled: canRunPanelQueries && _isPersonalDashboard,
  });

  const hasForensicsCapability =
    certificatesQuery.data?.billing.capabilities.some(
      (c) =>
        c.capabilityKey === BILLING_CAPABILITY_KEYS.couplingTraceability &&
        (c.status === 'active' || c.status === 'grace')
    ) ?? false;

  return (
    <aside id="sidebar" className="sidebar" aria-label="Main navigation">
      <SidebarLogoArea hasBootstrapPending={hasBootstrapPending} pendingGuild={pendingGuild} />

      <div className="sidebar-scroll">
        <nav className="sidebar-nav" aria-label="Dashboard sections">
          {/* Personal Config Sidebar */}
          <div className="personal-only">
            <div className="sidebar-nav-group">
              <span className="sidebar-nav-label">Global Config</span>
              <Link
                to="/dashboard"
                search={(prev) => prev}
                activeOptions={{ exact: true }}
                className="sidebar-nav-btn"
                activeProps={{ className: 'sidebar-nav-btn is-active' }}
                role="tab"
                aria-selected={false}
                aria-controls="tab-panel-setup"
              >
                <svg
                  className="sidebar-nav-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                </svg>
                Setup
              </Link>
            </div>
            <div className="sidebar-nav-group">
              <span className="sidebar-nav-label">Developer</span>
              <Link
                id="tab-btn-billing"
                to="/dashboard/billing"
                search={(prev) => ({
                  ...prev,
                  guild_id: undefined,
                  tenant_id: undefined,
                })}
                className="sidebar-nav-btn"
                activeProps={{ className: 'sidebar-nav-btn is-active' }}
                role="tab"
                aria-selected={false}
                aria-controls="tab-panel-billing"
              >
                <svg
                  className="sidebar-nav-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="2.5" y="5" width="19" height="14" rx="3" />
                  <path d="M2.5 10h19" />
                  <path d="M6.5 15h4" />
                </svg>
                Billing
              </Link>
              <Link
                id="tab-btn-certificates"
                to="/dashboard/certificates"
                search={(prev) => ({
                  ...prev,
                  guild_id: undefined,
                  tenant_id: undefined,
                })}
                className="sidebar-nav-btn"
                activeProps={{ className: 'sidebar-nav-btn is-active' }}
                role="tab"
                aria-selected={false}
                aria-controls="tab-panel-certificates"
              >
                <svg
                  className="sidebar-nav-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 2l7 4v6c0 5-3.2 9.4-7 10-3.8-.6-7-5-7-10V6z" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
                Certificates
              </Link>
              {hasForensicsCapability ? (
                <div className="sidebar-nav-reveal" key="sidebar-nav-forensics">
                  <Link
                    id="tab-btn-forensics"
                    to="/dashboard/forensics"
                    search={(prev) => ({
                      ...prev,
                      guild_id: undefined,
                      tenant_id: undefined,
                    })}
                    className="sidebar-nav-btn"
                    activeProps={{ className: 'sidebar-nav-btn is-active' }}
                    role="tab"
                    aria-selected={false}
                    aria-controls="tab-panel-forensics"
                  >
                    <svg
                      className="sidebar-nav-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <circle cx="11" cy="11" r="7" />
                      <path d="M21 21l-4.35-4.35" />
                      <path d="M11 8v6" />
                      <path d="M8 11h6" />
                    </svg>
                    Coupling Forensics
                  </Link>
                </div>
              ) : null}
              <Link
                to="/dashboard/integrations"
                search={(prev) => prev}
                className="sidebar-nav-btn"
                activeProps={{ className: 'sidebar-nav-btn is-active' }}
                role="tab"
                aria-selected={false}
                aria-controls="tab-panel-integrations"
              >
                <svg
                  className="sidebar-nav-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                Developer Integrations
              </Link>
            </div>
            <div className="sidebar-nav-group">
              <span className="sidebar-nav-label">Collaboration</span>
              <Link
                to="/dashboard/collaboration"
                search={(prev) => prev}
                className="sidebar-nav-btn"
                activeProps={{ className: 'sidebar-nav-btn is-active' }}
                role="tab"
                aria-selected={false}
                aria-controls="tab-panel-collaboration"
              >
                <svg
                  className="sidebar-nav-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                Collaborating Creators
              </Link>
            </div>
          </div>

          {/* Server Config Sidebar */}
          <div className="server-only">
            <div className="sidebar-nav-group">
              <span className="sidebar-nav-label">Configuration</span>
              <Link
                to="/dashboard"
                search={(prev) => prev}
                activeOptions={{ exact: true }}
                className="sidebar-nav-btn"
                activeProps={{ className: 'sidebar-nav-btn is-active' }}
                role="tab"
                aria-selected={false}
                aria-controls="tab-panel-setup"
              >
                <svg
                  className="sidebar-nav-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                General Settings
              </Link>
            </div>
            <div className="sidebar-nav-group">
              <span className="sidebar-nav-label">Moderation</span>
              <Link
                to="/dashboard/server-rules"
                search={(prev) => prev}
                className="sidebar-nav-btn"
                activeProps={{ className: 'sidebar-nav-btn is-active' }}
                role="tab"
                aria-selected={false}
                aria-controls="tab-panel-server-rules"
              >
                <svg
                  className="sidebar-nav-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                Server Rules
                <span className="sidebar-nav-soon">Soon</span>
              </Link>
              <Link
                to="/dashboard/audit-logs"
                search={(prev) => prev}
                className="sidebar-nav-btn"
                activeProps={{ className: 'sidebar-nav-btn is-active' }}
                role="tab"
                aria-selected={false}
                aria-controls="tab-panel-audit-logs"
              >
                <svg
                  className="sidebar-nav-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
                Audit Logs
                <span className="sidebar-nav-soon">Soon</span>
              </Link>
            </div>
          </div>
        </nav>
      </div>

      <div className="sidebar-footer">
        <Link
          to="/account"
          search={(prev) => prev}
          className="sidebar-account-btn"
          aria-label="My Account"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          My Account
        </Link>
      </div>
    </aside>
  );
}
/*  Sidebar Logo + Server Selector                                     */
/* ------------------------------------------------------------------ */

function SidebarLogoArea({
  hasBootstrapPending,
  pendingGuild,
}: {
  hasBootstrapPending: boolean;
  pendingGuild?: PendingDashboardGuild;
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectorButtonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const { guild_id } = Route.useSearch();
  const { signOut } = useAuth();
  const { guilds, selectedGuild } = useDashboardShell();
  const [selectorRect, setSelectorRect] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const filteredGuilds = useMemo(() => {
    if (!guilds) return [];
    if (!searchQuery) return guilds;
    const q = searchQuery.toLowerCase();
    return guilds.filter((g) => g.name.toLowerCase().includes(q));
  }, [guilds, searchQuery]);

  const toggleDropdown = useCallback(() => {
    setDropdownOpen((prev) => {
      const next = !prev;
      if (next) {
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      return next;
    });
    setSearchQuery('');
  }, []);

  const syncSelectorRect = useCallback(() => {
    const rect = selectorButtonRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    setSelectorRect({
      top: rect.top,
      left: rect.left,
      width: rect.width,
    });
  }, []);

  const selectGuild = useCallback(
    (guild: Guild) => {
      navigate({
        to: '/dashboard',
        search: {
          guild_id: guild.id,
          tenant_id: guild.tenantId,
        },
      });
      setDropdownOpen(false);
      setSearchQuery('');
    },
    [navigate]
  );

  const addServer = useCallback(() => {
    if (typeof window === 'undefined') return;
    setDropdownOpen(false);
    window.location.assign('/api/install/bot');
  }, []);

  const openCreatorHome = useCallback(() => {
    setDropdownOpen(false);
    setSearchQuery('');
    navigate({
      to: '/dashboard',
      search: {},
    });
  }, [navigate]);

  // Close dropdown when clicking the backdrop
  useEffect(() => {
    const backdrop = document.getElementById('server-dropdown-backdrop');
    if (!backdrop) return;
    const handler = () => {
      setDropdownOpen(false);
      setSearchQuery('');
    };
    backdrop.addEventListener('click', handler);
    return () => backdrop.removeEventListener('click', handler);
  }, []);

  // Toggle backdrop visibility class
  useEffect(() => {
    const backdrop = document.getElementById('server-dropdown-backdrop');
    if (!backdrop) return;
    if (dropdownOpen) {
      backdrop.classList.add('is-visible');
    } else {
      backdrop.classList.remove('is-visible');
    }
  }, [dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen) {
      return;
    }

    syncSelectorRect();

    const handler = () => syncSelectorRect();
    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);

    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, [dropdownOpen, syncSelectorRect]);

  const selectedServer = selectedGuild ?? pendingGuild;
  const selectedName =
    selectedServer?.name ?? (hasBootstrapPending ? 'Linking server...' : 'Select a Server');
  const selectorPortalStyle = selectorRect
    ? ({
        '--selector-top': `${selectorRect.top}px`,
        '--selector-left': `${selectorRect.left}px`,
        '--selector-width': `${selectorRect.width}px`,
      } as CSSProperties)
    : undefined;

  const renderSelectorTrigger = (
    id: string,
    options?: {
      ref?: typeof selectorButtonRef;
      hidden?: boolean;
    }
  ) => (
    <button
      ref={options?.ref}
      type="button"
      className="sidebar-server-pill"
      id={id}
      onClick={toggleDropdown}
      aria-haspopup="menu"
      aria-expanded={dropdownOpen}
      aria-controls="server-dropdown-menu"
      style={
        options?.hidden
          ? {
              visibility: 'hidden',
              pointerEvents: 'none',
            }
          : undefined
      }
    >
      <div className="sidebar-server-info">
        <div className="sidebar-server-icon" id="sidebar-selected-icon">
          {selectedServer?.icon ? (
            <img
              src={getServerIconUrl(selectedServer.id, selectedServer.icon) ?? ''}
              alt=""
              style={{
                width: '100%',
                height: '100%',
                borderRadius: '6px',
                objectFit: 'cover',
              }}
            />
          ) : selectedServer?.name ? (
            <span style={{ fontSize: '12px', fontWeight: 800, lineHeight: 1 }}>
              {selectedServer.name.charAt(0).toUpperCase()}
            </span>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <path d="M9 22v-8h6v8" />
            </svg>
          )}
        </div>
        <span className="sidebar-server-name" id="sidebar-selected-name">
          {selectedName}
        </span>
      </div>
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="sidebar-server-chevron"
        aria-hidden="true"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );

  const renderDropdownMenu = () => (
    <div
      className={`server-dropdown-menu${dropdownOpen ? ' open' : ''}`}
      id="server-dropdown-menu"
      role="menu"
      aria-label="Server selector"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="server-dropdown-search">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={searchInputRef}
          type="text"
          id="server-search-input"
          placeholder="Search servers..."
          autoComplete="off"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="server-dropdown-list" id="server-dropdown-list">
        {filteredGuilds.length === 0 ? (
          <div className="server-dropdown-empty">
            {searchQuery ? 'No servers found' : 'No servers configured yet'}
          </div>
        ) : (
          filteredGuilds.map((guild) => (
            <button
              key={guild.id}
              type="button"
              className={`server-dropdown-item${guild.id === guild_id ? ' is-selected' : ''}`}
              onClick={() => selectGuild(guild)}
            >
              <div className="server-dropdown-item-icon">
                {guild.icon ? (
                  <img src={getServerIconUrl(guild.id, guild.icon) ?? ''} alt="" />
                ) : (
                  <span>{guild.name.charAt(0)}</span>
                )}
              </div>
              <span className="server-dropdown-item-name">{guild.name}</span>
            </button>
          ))
        )}
      </div>
      <div className="server-dropdown-footer">
        <button
          type="button"
          className="server-dropdown-action-btn"
          id="btn-creator-home"
          onClick={openCreatorHome}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 10.5 12 3l9 7.5" />
            <path d="M5 9.5V21h14V9.5" />
          </svg>
          Creator Home
        </button>
        <button
          type="button"
          className="server-dropdown-action-btn"
          id="btn-add-server"
          onClick={addServer}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add a Server
        </button>
        <div className="server-dropdown-divider" />
        <button
          type="button"
          className="server-dropdown-action-btn"
          id="btn-sign-out"
          style={{ color: 'rgba(239,68,68,0.85)' }}
          onClick={signOut}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Sign Out
        </button>
      </div>
    </div>
  );

  return (
    <div className="sidebar-logo-area">
      <div className="sidebar-brand">
        <img src="/Icons/MainLogo.png" alt="Creator Assistant Logo" className="sidebar-logo-img" />
      </div>
      <div className="sidebar-server-selector">
        {renderSelectorTrigger('sidebar-server-selector', {
          ref: selectorButtonRef,
          hidden: dropdownOpen,
        })}
        {dropdownOpen && selectorPortalStyle ? (
          <DashboardBodyPortal>
            <div className="server-selector-portal" style={selectorPortalStyle}>
              {renderSelectorTrigger('sidebar-server-selector-portal')}
              {renderDropdownMenu()}
            </div>
          </DashboardBodyPortal>
        ) : null}
      </div>
    </div>
  );
}

function DashboardRouteErrorComponent({ error }: { error: Error }) {
  return (
    <div className="dashboard-page">
      <CloudBackground variant="default" />
      <div className="app-shell">
        <main className="content-area">
          <DotMatrixBackground />
          <div className="content-area-inner">
            <section className="section-card bento-col-12 p-6 sm:p-7 md:p-8">
              <div className="content-header-eyebrow">Dashboard Error</div>
              <h1 className="content-header-title">Dashboard unavailable</h1>
              <p
                className="content-header-desc"
                style={{ fontFamily: "'AirbnbCereal', sans-serif" }}
              >
                The dashboard shell could not be loaded. Refresh the page or sign in again if the
                problem persists.
              </p>
              <pre
                style={{
                  marginTop: '20px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'rgba(255,255,255,0.72)',
                }}
              >
                {error.message}
              </pre>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Dot-Matrix Interactive Background                                 */
/* ------------------------------------------------------------------ */

function DotMatrixBackground() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;

    const handleMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      el.style.setProperty('--dot-x', `${e.clientX - rect.left}px`);
      el.style.setProperty('--dot-y', `${e.clientY - rect.top}px`);
    };

    const handleLeave = () => {
      el.style.setProperty('--dot-x', '-9999px');
      el.style.setProperty('--dot-y', '-9999px');
    };

    parent.addEventListener('mousemove', handleMove);
    parent.addEventListener('mouseleave', handleLeave);

    return () => {
      parent.removeEventListener('mousemove', handleMove);
      parent.removeEventListener('mouseleave', handleLeave);
    };
  }, []);

  return <div ref={ref} className="dot-matrix-bg" aria-hidden="true" />;
}

/* ------------------------------------------------------------------ */
/*  Main Content Area                                                  */
/* ------------------------------------------------------------------ */

function MainContent({ pendingGuild }: { pendingGuild?: PendingDashboardGuild }) {
  const { selectedGuild } = useDashboardShell();
  const { guild_id } = Route.useSearch();
  const displayGuild = selectedGuild ?? pendingGuild;
  const isPersonalDashboard = !displayGuild && !guild_id;

  const title = isPersonalDashboard ? 'Dashboard' : (displayGuild?.name ?? 'Server');

  const headerGuild = displayGuild?.name
    ? {
        id: displayGuild.id,
        icon: displayGuild.icon ?? null,
        name: displayGuild.name,
      }
    : undefined;

  return (
    <main className="content-area">
      <DotMatrixBackground />
      <div className="content-area-inner">
        <DashboardHeader title={title} selectedGuild={headerGuild} />

        <Outlet />
      </div>
    </main>
  );
}
