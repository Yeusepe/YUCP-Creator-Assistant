import { createFileRoute, Link, Outlet, redirect, useRouterState } from '@tanstack/react-router';
import { CloudBackground } from '@/components/three/CloudBackground';
import { useAccountShell } from '@/hooks/useAccountShell';
import { dashboardShellQueryOptions } from '@/lib/dashboardQueryOptions';
import { fetchDashboardShell } from '@/lib/server/dashboard';
import '@/styles/dashboard.css';
import '@/styles/account.css';

export const Route = createFileRoute('/account')({
  beforeLoad: ({ context, location }) => {
    if (!context.isAuthenticated) {
      throw redirect({
        to: '/sign-in',
        search: { redirectTo: location.href },
      });
    }
  },
  loader: async ({ context: { queryClient } }) => {
    return queryClient.ensureQueryData(
      dashboardShellQueryOptions({
        queryKey: ['dashboard-shell'],
        queryFn: () => fetchDashboardShell(),
      })
    );
  },
  component: AccountLayout,
});

const NAV_ITEMS = [
  {
    to: '/account' as const,
    exact: true,
    label: 'Profile',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
      </svg>
    ),
  },
  {
    to: '/account/connections' as const,
    exact: false,
    label: 'Connected Accounts',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    ),
  },
  {
    to: '/account/licenses' as const,
    exact: false,
    label: 'My Licenses',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 9h6M9 13h6M9 17h4" />
      </svg>
    ),
  },
  {
    to: '/account/authorized-apps' as const,
    exact: false,
    label: 'Authorized Apps',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" />
      </svg>
    ),
  },
  {
    to: '/account/privacy' as const,
    exact: false,
    label: 'Privacy & Data',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
];

function toggleAccountSidebar() {
  if (typeof document === 'undefined') return;
  const sidebar = document.getElementById('acct-sidebar');
  const overlay = document.getElementById('acct-sidebar-overlay');
  if (sidebar && overlay) {
    const isOpen = sidebar.classList.toggle('is-open');
    if (isOpen) overlay.classList.add('is-visible');
    else overlay.classList.remove('is-visible');
  }
}

function AccountLayout() {
  const { guilds } = useAccountShell();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const isCreator = guilds.length > 0;

  return (
    <div className="dashboard-page">
      <div className="app-shell">
        <div
          id="acct-sidebar-overlay"
          className="sidebar-overlay"
          aria-hidden="true"
          onClick={toggleAccountSidebar}
        />

        <CloudBackground variant="default" />

        <aside id="acct-sidebar" className="sidebar" aria-label="Account navigation">
          <div className="sidebar-logo-area">
            <div className="sidebar-brand">
              <img src="/Icons/Bag.png" alt="Creator Assistant" className="sidebar-logo-img" />
              <span className="acct-sidebar-title">My Account</span>
            </div>
          </div>

          <div className="sidebar-scroll">
            <nav className="sidebar-nav" aria-label="Account sections">
              <div className="sidebar-nav-group">
                {NAV_ITEMS.map((item) => {
                  const isActive = item.exact
                    ? currentPath === item.to || currentPath === `${item.to}/`
                    : currentPath.startsWith(item.to);
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={`sidebar-nav-btn${isActive ? ' is-active' : ''}`}
                    >
                      <span className="sidebar-nav-icon">{item.icon}</span>
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </nav>
          </div>

          <div className="sidebar-footer">
            {isCreator && (
              <Link to="/dashboard" className="sidebar-nav-btn">
                <span className="sidebar-nav-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="7" height="7" rx="1" />
                    <rect x="14" y="3" width="7" height="7" rx="1" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                    <rect x="14" y="14" width="7" height="7" rx="1" />
                  </svg>
                </span>
                Creator Dashboard
              </Link>
            )}
          </div>
        </aside>

        <main className="content-area">
          <div className="content-area-inner">
            <div className="acct-mobile-header">
              <button
                type="button"
                className="sidebar-toggle-btn"
                aria-label="Open account menu"
                onClick={toggleAccountSidebar}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 12h18M3 6h18M3 18h18" />
                </svg>
              </button>
            </div>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
