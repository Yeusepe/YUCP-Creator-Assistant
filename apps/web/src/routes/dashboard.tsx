import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, Outlet, redirect, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CloudBackground } from '@/components/three/CloudBackground';
import { useAuth } from '@/hooks/useAuth';
import { ServerContextProvider } from '@/hooks/useServerContext';
import { useTheme } from '@/hooks/useTheme';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';
import { fetchGuilds, type Guild } from '@/lib/server/dashboard';
import { getServerIconUrl } from '@/lib/utils';

interface DashboardSearch {
  guild_id?: string;
  tenant_id?: string;
}

export const Route = createFileRoute('/dashboard')({
  validateSearch: (search: Record<string, unknown>): DashboardSearch => ({
    guild_id: (search.guild_id as string) || undefined,
    tenant_id: (search.tenant_id as string) || undefined,
  }),
  head: () => ({
    links: routeStylesheetLinks(routeStyleHrefs.dashboard, routeStyleHrefs.dashboardComponents),
  }),
  beforeLoad: ({ context, location }) => {
    if (!context.isAuthenticated) {
      throw redirect({
        to: '/sign-in',
        search: { redirectTo: location.href },
      });
    }
  },
  component: DashboardLayout,
});

/* ------------------------------------------------------------------ */

function DashboardLayout() {
  const { guild_id, tenant_id } = Route.useSearch();
  const isPersonalDashboard = !guild_id;

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
    <ServerContextProvider guildId={guild_id} tenantId={tenant_id}>
      <div className="dashboard-page">
        <div className="app-shell">
          <SidebarOverlay />
          <ServerDropdownBackdrop />
          <BlobBackground />
          <CloudBackground variant="default" />
          <Sidebar />
          <MainContent />
        </div>
      </div>
    </ServerContextProvider>
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
/*  Blob Background                                                    */
/* ------------------------------------------------------------------ */

function BlobBackground() {
  return (
    <div className="blobs-container">
      <div className="blob" />
      <div className="blob" />
      <div className="blob" />
      <div className="blob" />
      <div className="blob" />
    </div>
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

function Sidebar() {
  const { guild_id } = Route.useSearch();
  const _isPersonalDashboard = !guild_id;

  return (
    <aside id="sidebar" className="sidebar" aria-label="Main navigation">
      <SidebarLogoArea />

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
              </Link>
            </div>
          </div>
        </nav>
      </div>

      <div className="sidebar-footer" />
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/*  Sidebar Logo + Server Selector                                     */
/* ------------------------------------------------------------------ */

function SidebarLogoArea() {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { guild_id } = Route.useSearch();
  const { signOut } = useAuth();

  const { data: guilds, isLoading } = useQuery<Guild[]>({
    queryKey: ['dashboard-guilds'],
    queryFn: () => fetchGuilds(),
  });

  const selectedGuild = useMemo(() => guilds?.find((g) => g.id === guild_id), [guilds, guild_id]);

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

  const goPersonal = useCallback(() => {
    navigate({ to: '/dashboard', search: {} });
    setDropdownOpen(false);
    setSearchQuery('');
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

  const selectedName = selectedGuild?.name ?? 'Personal Dashboard';

  return (
    <div className="sidebar-logo-area">
      <div className="sidebar-brand">
        <img src="/Icons/MainLogo.png" alt="Creator Assistant Logo" className="sidebar-logo-img" />
      </div>
      <button
        type="button"
        className="sidebar-server-pill"
        id="sidebar-server-selector"
        onClick={toggleDropdown}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleDropdown();
          }
        }}
      >
        <div className="sidebar-server-info">
          <div className="sidebar-server-icon" id="sidebar-selected-icon">
            {selectedGuild?.icon ? (
              <img
                src={getServerIconUrl(selectedGuild.id, selectedGuild.icon) ?? ''}
                alt=""
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  objectFit: 'cover',
                }}
              />
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
                <path d="M6 9l6 6 6-6" />
              </svg>
            )}
          </div>
          <span className="sidebar-server-name text-white" id="sidebar-selected-name">
            {selectedName}
          </span>
        </div>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgba(255,255,255,0.4)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="sidebar-server-chevron"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>

        {/* biome-ignore lint/a11y/noStaticElementInteractions: stops click from closing dropdown */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops propagation, no action */}
        <div
          className={`server-dropdown-menu${dropdownOpen ? ' is-open' : ''}`}
          id="server-dropdown-menu"
          onClick={(e) => e.stopPropagation()}
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
            {isLoading ? (
              <div className="server-dropdown-loading">Loading servers...</div>
            ) : filteredGuilds.length === 0 ? (
              <div className="server-dropdown-loading">No servers found</div>
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
              id="btn-personal-dashboard"
              onClick={goPersonal}
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
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              Personal Dashboard
            </button>
            <div
              style={{
                height: '1px',
                background: 'rgba(0,0,0,0.1)',
                margin: '2px 4px',
              }}
            />
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
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Content Area                                                  */
/* ------------------------------------------------------------------ */

function MainContent() {
  const { isDark, toggleTheme } = useTheme();

  return (
    <main className="content-area">
      {/* Header */}
      <header className="content-area-header animate-in relative z-10">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="flex items-start gap-3 w-full md:w-auto">
            <button
              id="sidebar-toggle"
              type="button"
              className="sidebar-toggle-btn"
              aria-label="Open menu"
              onClick={toggleSidebarGlobal}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 12h18M3 6h18M3 18h18" />
              </svg>
            </button>
            <div className="relative flex-1 min-w-0">
              <div className="content-header-eyebrow">Server Dashboard</div>
              <h1 className="content-header-title">Dashboard</h1>
              <p className="content-header-desc" style={{ fontFamily: "'DM Sans', sans-serif" }}>
                Connect your storefronts, verify webhooks, and tune server behavior without bouncing
                between separate setup pages.
              </p>
            </div>
          </div>
          <div className="content-header-actions flex items-center justify-end gap-3 w-full md:w-auto mt-4 md:mt-0">
            <button
              id="theme-toggle"
              type="button"
              className="btn-ghost !px-3 !py-2 !rounded-xl"
              aria-label="Toggle Dark Mode"
              onClick={toggleTheme}
              title="Toggle Dark Mode"
            >
              <svg
                className={`sun-icon${isDark ? '' : ' hidden'}`}
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
              <svg
                className={`moon-icon${isDark ? ' hidden' : ''}`}
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <Outlet />
    </main>
  );
}
