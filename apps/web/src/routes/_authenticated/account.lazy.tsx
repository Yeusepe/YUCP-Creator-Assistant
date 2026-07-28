import { createLazyFileRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { CloudBackground } from '@/components/three/CloudBackground';
import { Icon } from '@/components/ui/Icon';
import { useAccountShell } from '@/hooks/useAccountShell';
import { useAuth } from '@/hooks/useAuth';
import { DashboardSessionProvider } from '@/hooks/useDashboardSession';
import type { IconName } from '@/icons/manifest';

export const Route = createLazyFileRoute('/_authenticated/account')({
  component: AccountLayout,
});

const NAV_GROUPS = [
  {
    label: 'Overview',
    theme: 'sky',
    items: [
      {
        to: '/account' as const,
        exact: true,
        label: 'Profile',
        headerTitle: 'Profile',
        icon: 'profile',
      },
      {
        to: '/account/connections' as const,
        exact: false,
        label: 'Connected Accounts',
        headerTitle: 'Connected Accounts',
        icon: 'link',
      },
    ],
  },
  {
    label: 'Access',
    theme: 'amber',
    items: [
      {
        to: '/account/licenses' as const,
        exact: false,
        label: 'My Licenses',
        headerTitle: 'Verified Purchases',
        icon: 'userKey',
      },
      {
        to: '/account/authorized-apps' as const,
        exact: false,
        label: 'Authorized Apps',
        headerTitle: 'Authorized Apps',
        icon: 'plug',
      },
      {
        to: '/account/machines' as const,
        exact: false,
        label: 'Authorized Machines',
        headerTitle: 'Authorized Machines',
        icon: 'desktop',
      },
    ],
  },
  {
    label: 'Billing',
    theme: 'teal',
    items: [
      {
        to: '/account/billing' as const,
        exact: false,
        label: 'Billing & Plans',
        headerTitle: 'Billing',
        icon: 'billing',
      },
    ],
  },
  {
    label: 'Privacy',
    theme: 'violet',
    items: [
      {
        to: '/account/security' as const,
        exact: false,
        label: 'Security',
        headerTitle: 'Security',
        icon: 'shield',
      },
      {
        to: '/account/privacy' as const,
        exact: false,
        label: 'Privacy & Data',
        headerTitle: 'Privacy & Data',
        icon: 'privacy',
      },
    ],
  },
] as const;

const ACCOUNT_HEADER_TITLES: Record<string, string> = {
  '/account/verify': 'Verify Purchase',
};

function normalizeAccountPath(currentPath: string): string {
  if (currentPath === '/') {
    return currentPath;
  }
  return currentPath.replace(/\/+$/u, '') || '/';
}

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

function getAccountHeaderTitle(currentPath: string): string {
  const normalizedPath = normalizeAccountPath(currentPath);
  const activeItem = findActiveNavItem(normalizedPath);
  if (activeItem.to === '/account' && normalizedPath !== '/account') {
    return ACCOUNT_HEADER_TITLES[normalizedPath] ?? activeItem.headerTitle;
  }

  return activeItem.headerTitle;
}

function closeAccountSidebar() {
  if (typeof document === 'undefined') return;
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar && overlay) {
    sidebar.classList.remove('is-open');
    overlay.classList.remove('is-visible');
  }
}

function _toggleAccountSidebar() {
  if (typeof document === 'undefined') return;
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar && overlay) {
    const isOpen = sidebar.classList.toggle('is-open');
    if (isOpen) {
      overlay.classList.add('is-visible');
    } else {
      closeAccountSidebar();
    }
  }
}

function AccountLayout() {
  const { creatorAccount } = useAccountShell();
  const { signOut } = useAuth();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const isCreator = creatorAccount.isActive;
  const footerHref = isCreator ? '/dashboard' : '/account#creator-account';
  const footerLabel = isCreator ? 'Creator Dashboard' : 'Become a Creator';

  return (
    <DashboardSessionProvider>
      <div className="dashboard-page">
        <CloudBackground variant="default" />
        <div className="app-shell">
          <div
            id="sidebar-overlay"
            className="sidebar-overlay"
            aria-hidden="true"
            onClick={closeAccountSidebar}
          />

          <aside id="sidebar" className="sidebar" aria-label="Account navigation">
            <div className="sidebar-logo-area">
              <div className="sidebar-brand">
                <img
                  src="/Icons/MainLogo.png"
                  alt="Creator Assistant Logo"
                  className="sidebar-logo-img"
                />
              </div>
            </div>

            <div className="sidebar-scroll">
              <nav className="sidebar-nav" aria-label="Account sections">
                {NAV_GROUPS.map((group) => (
                  <div
                    key={group.label}
                    className="sidebar-nav-group"
                    data-icon-theme={group.theme}
                  >
                    <span className="sidebar-nav-label">{group.label}</span>
                    {group.items.map((item) => (
                      <Link
                        key={item.to}
                        to={item.to}
                        onClick={closeAccountSidebar}
                        className={`sidebar-nav-btn${isNavItemActive(item, currentPath) ? ' is-active' : ''}`}
                      >
                        <Icon name={item.icon satisfies IconName} className="sidebar-nav-icon" />
                        {item.label}
                      </Link>
                    ))}
                  </div>
                ))}
              </nav>
            </div>

            <div className="sidebar-footer">
              <a href={footerHref} className="sidebar-account-btn">
                <Icon name={isCreator ? 'layoutGrid' : 'add'} size={15} />
                {footerLabel}
              </a>
              <button
                type="button"
                className="sidebar-account-btn"
                onClick={() => {
                  void signOut();
                }}
              >
                <Icon name="logout" size={15} />
                Sign out
              </button>
            </div>
          </aside>

          <main className="content-area">
            <div className="content-area-inner">
              <DashboardHeader
                title={getAccountHeaderTitle(currentPath)}
                homeHref="/account"
                homeLabel="Back to account home"
              />
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </DashboardSessionProvider>
  );
}
