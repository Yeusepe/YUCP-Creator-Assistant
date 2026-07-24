import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createLazyFileRoute, Link, Outlet, useNavigate } from '@tanstack/react-router';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiClient } from '@/api/client';
import { DashboardBodyPortal } from '@/components/dashboard/DashboardBodyPortal';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { CloudBackground } from '@/components/three/CloudBackground';
import { Icon } from '@/components/ui/Icon';
import { useAuth } from '@/hooks/useAuth';
import { DashboardSessionProvider, useDashboardSession } from '@/hooks/useDashboardSession';
import { useDashboardShell } from '@/hooks/useDashboardShell';
import { ServerContextProvider } from '@/hooks/useServerContext';
import { hasActiveCreatorBillingCapability, listCreatorCertificates } from '@/lib/certificates';
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

  const hasVpmRepoCapability = hasActiveCreatorBillingCapability(
    certificatesQuery.data?.billing.capabilities,
    BILLING_CAPABILITY_KEYS.vpmRepo
  );
  const hasCouplingTraceabilityCapability = hasActiveCreatorBillingCapability(
    certificatesQuery.data?.billing.capabilities,
    BILLING_CAPABILITY_KEYS.couplingTraceability
  );

  return (
    <aside id="sidebar" className="sidebar" aria-label="Main navigation">
      <SidebarLogoArea hasBootstrapPending={hasBootstrapPending} pendingGuild={pendingGuild} />

      <div className="sidebar-scroll">
        <nav className="sidebar-nav" aria-label="Dashboard sections">
          {/* Personal Config Sidebar */}
          <div className="personal-only">
            <div className="sidebar-nav-group" data-icon-theme="sky">
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
                <Icon name="home" className="sidebar-nav-icon" />
                Setup
              </Link>
            </div>
            <div className="sidebar-nav-group" data-icon-theme="amber">
              <span className="sidebar-nav-label">Developer</span>
              {hasVpmRepoCapability || hasCouplingTraceabilityCapability ? (
                <Link
                  to="/dashboard/packages"
                  search={(prev) => ({
                    ...prev,
                    guild_id: undefined,
                    tenant_id: undefined,
                    view: undefined,
                  })}
                  className="sidebar-nav-btn"
                  activeProps={{ className: 'sidebar-nav-btn is-active' }}
                >
                  <Icon name="package" className="sidebar-nav-icon" />
                  Packages
                </Link>
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
                <Icon name="lock" className="sidebar-nav-icon" />
                Developer Integrations
              </Link>
            </div>
            <div className="sidebar-nav-group" data-icon-theme="teal">
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
                <Icon name="users" className="sidebar-nav-icon" />
                Collaborating Creators
              </Link>
            </div>
          </div>

          {/* Server Config Sidebar */}
          <div className="server-only">
            <div className="sidebar-nav-group" data-icon-theme="violet">
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
                <Icon name="settings" className="sidebar-nav-icon" />
                General Settings
              </Link>
            </div>
            <div className="sidebar-nav-group" data-icon-theme="rose">
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
                <Icon name="shield" className="sidebar-nav-icon" />
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
                <Icon name="auditLog" className="sidebar-nav-icon" />
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
          <Icon name="user" size={15} />
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
            <Icon name="home" size={14} />
          )}
        </div>
        <span className="sidebar-server-name" id="sidebar-selected-name">
          {selectedName}
        </span>
      </div>
      <Icon name="chevronDown" className="sidebar-server-chevron" size={12} />
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
        <Icon name="search" size={14} />
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
          <Icon name="home" size={14} />
          Creator Home
        </button>
        <button
          type="button"
          className="server-dropdown-action-btn"
          id="btn-add-server"
          onClick={addServer}
        >
          <Icon name="add" size={14} />
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
          <Icon name="logout" size={14} />
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
  const dashboardRouteErrorDetail = import.meta.env.DEV
    ? error.message
    : 'Dashboard failed to load.';

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
                {dashboardRouteErrorDetail}
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
