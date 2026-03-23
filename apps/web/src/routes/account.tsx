import { createFileRoute, Link, Outlet, redirect, useRouterState } from '@tanstack/react-router';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { CloudBackground } from '@/components/three/CloudBackground';
import { useAccountShell } from '@/hooks/useAccountShell';
import { dashboardShellQueryOptions } from '@/lib/dashboardQueryOptions';
import { primeDashboardShellCaches } from '@/lib/dashboardShellCache';
import { fetchDashboardShell } from '@/lib/server/dashboard';
import '@/styles/dashboard.css';
import '@/styles/dashboard-components.css';
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
    const shell = await queryClient.ensureQueryData(
      dashboardShellQueryOptions({
        queryKey: ['dashboard-shell'],
        queryFn: () => fetchDashboardShell({ data: { includeHomeData: false } }),
      })
    );
    primeDashboardShellCaches(queryClient, shell);
    return shell;
  },
  component: AccountLayout,
});

const NAV_GROUPS = [
  {
    label: 'Overview',
    items: [
      {
        to: '/account' as const,
        exact: true,
        label: 'Profile',
        headerTitle: 'Profile',
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
          </svg>
        ),
      },
      {
        to: '/account/connections' as const,
        exact: false,
        label: 'Connected Accounts',
        headerTitle: 'Connected Accounts',
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Access',
    items: [
      {
        to: '/account/licenses' as const,
        exact: false,
        label: 'My Licenses',
        headerTitle: 'Verified Purchases',
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 9h6M9 13h6M9 17h4" />
          </svg>
        ),
      },
      {
        to: '/account/authorized-apps' as const,
        exact: false,
        label: 'Authorized Apps',
        headerTitle: 'Authorized Apps',
        icon: (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Privacy',
    items: [
      {
        to: '/account/privacy' as const,
        exact: false,
        label: 'Privacy & Data',
        headerTitle: 'Privacy & Data',
        icon: (
          <svg
            width="16"
            height="16"
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
        ),
      },
    ],
  },
] as const;

function isNavItemActive(item: (typeof NAV_GROUPS)[number]['items'][number], currentPath: string) {
  return item.exact
    ? currentPath === item.to || currentPath === `${item.to}/`
    : currentPath.startsWith(item.to);
}

function findActiveNavItem(currentPath: string) {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (isNavItemActive(item, currentPath)) {
        return item;
      }
    }
  }

  return NAV_GROUPS[0].items[0];
}

function toggleAccountSidebar() {
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

function AccountLayout() {
  const { guilds, viewer } = useAccountShell();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const activeItem = findActiveNavItem(currentPath);
  const isCreator = guilds.length > 0;
  const footerHref = isCreator
    ? '/dashboard'
    : `/api/install/bot?authUserId=${encodeURIComponent(viewer.authUserId)}`;
  const footerLabel = isCreator ? 'Creator Dashboard' : 'Add a Server';

  return (
    <div className="dashboard-page">
      <div className="app-shell">
        <div
          id="sidebar-overlay"
          className="sidebar-overlay"
          aria-hidden="true"
          onClick={toggleAccountSidebar}
        />

        <CloudBackground variant="default" />

        <aside id="sidebar" className="sidebar" aria-label="Account navigation">
          <div className="sidebar-logo-area">
            <div className="sidebar-brand">
              <img src="/Icons/MainLogo.png" alt="Creator Assistant" className="sidebar-logo-img" />
            </div>
          </div>

          <div className="sidebar-scroll">
            <nav className="sidebar-nav" aria-label="Account sections">
              {NAV_GROUPS.map((group) => (
                <div key={group.label} className="sidebar-nav-group">
                  <span className="sidebar-nav-label">{group.label}</span>
                  {group.items.map((item) => (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={`sidebar-nav-btn${isNavItemActive(item, currentPath) ? ' is-active' : ''}`}
                    >
                      <span className="sidebar-nav-icon">{item.icon}</span>
                      {item.label}
                    </Link>
                  ))}
                </div>
              ))}
            </nav>
          </div>

          <div className="sidebar-footer">
            <a href={footerHref} className="sidebar-account-btn">
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
                {isCreator ? (
                  <>
                    <rect x="3" y="3" width="7" height="7" rx="1" />
                    <rect x="14" y="3" width="7" height="7" rx="1" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                    <rect x="14" y="14" width="7" height="7" rx="1" />
                  </>
                ) : (
                  <>
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </>
                )}
              </svg>
              {footerLabel}
            </a>
          </div>
        </aside>

        <main className="content-area">
          <div className="content-area-inner">
            <DashboardHeader
              title={activeItem.headerTitle}
              homeHref="/account"
              homeLabel="Back to account home"
            />
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
