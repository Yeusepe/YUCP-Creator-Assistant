import { Link } from '@tanstack/react-router';
import { Icon } from '@/components/ui/Icon';
import { useTheme } from '@/hooks/useTheme';
import { getServerIconUrl } from '@/lib/utils';

export interface DashboardHeaderProps {
  title: string;
  homeHref?: string;
  homeLabel?: string;
  selectedGuild?: {
    id: string;
    icon?: string | null;
    name: string;
  };
}

function toggleSidebar() {
  if (typeof document === 'undefined') return;
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar && overlay) {
    const isOpen = sidebar.classList.toggle('is-open');
    overlay.classList.toggle('is-visible', isOpen);
    overlay.setAttribute('aria-hidden', String(!isOpen));
    document.body.style.overflow = isOpen ? 'hidden' : '';
  }
}

export function DashboardHeader({
  title,
  homeHref = '/dashboard',
  homeLabel = 'Back to dashboard home',
  selectedGuild,
}: DashboardHeaderProps) {
  const { isDark, toggleTheme } = useTheme();

  const contextIcon = selectedGuild?.icon ? (
    <img src={getServerIconUrl(selectedGuild.id, selectedGuild.icon) ?? ''} alt="" />
  ) : (
    <Icon name="home" size={18} />
  );

  const homeIconLink =
    homeHref === '/account' ? (
      <Link
        to="/account"
        activeOptions={{ exact: true }}
        className="header-context-icon"
        aria-label={homeLabel}
        title={homeLabel}
      >
        {contextIcon}
      </Link>
    ) : homeHref === '/dashboard' ? (
      <Link
        to="/dashboard"
        search={{}}
        activeOptions={{ exact: true }}
        className="header-context-icon"
        aria-label={homeLabel}
        title={homeLabel}
      >
        {contextIcon}
      </Link>
    ) : (
      <a href={homeHref} className="header-context-icon" aria-label={homeLabel} title={homeLabel}>
        {contextIcon}
      </a>
    );

  return (
    <header className="content-area-header">
      <div className="dashboard-header-shell">
        <div className="dashboard-header-leading">
          {homeIconLink}
          <h1 className="content-header-title truncate">{title}</h1>
        </div>

        <div className="dashboard-header-actions">
          <a
            href="https://creators.yucp.club/docs.html"
            target="_blank"
            rel="noopener noreferrer"
            className="dashboard-header-icon-btn"
            aria-label="Documentation"
            title="Creator docs"
          >
            <Icon name="documentation" size={18} />
          </a>
          <button
            id="theme-toggle"
            type="button"
            className="dashboard-header-icon-btn"
            aria-label="Toggle Dark Mode"
            onClick={toggleTheme}
            title="Toggle Dark Mode"
          >
            <Icon name="sun" className={isDark ? '' : 'hidden'} size={18} />
            <Icon name="moon" className={isDark ? 'hidden' : ''} size={18} />
          </button>
          <button
            id="sidebar-toggle"
            type="button"
            className="sidebar-toggle-btn dashboard-header-icon-btn"
            aria-label="Open menu"
            onClick={toggleSidebar}
          >
            <Icon name="menu" size={20} />
          </button>
        </div>
      </div>
    </header>
  );
}
