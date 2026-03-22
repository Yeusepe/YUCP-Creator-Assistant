import { Link } from '@tanstack/react-router';
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
    <svg
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
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22v-8h6v8" />
    </svg>
  );

  const homeIconLink =
    homeHref === '/account' ? (
      <Link to="/account" className="header-context-icon" aria-label={homeLabel} title={homeLabel}>
        {contextIcon}
      </Link>
    ) : homeHref === '/dashboard' ? (
      <Link
        to="/dashboard"
        search={{}}
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
    <header className="content-area-header animate-in relative z-10">
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
            <img src="/Icons/Library.png" alt="" />
          </a>
          <button
            id="theme-toggle"
            type="button"
            className="dashboard-header-icon-btn"
            aria-label="Toggle Dark Mode"
            onClick={toggleTheme}
            title="Toggle Dark Mode"
          >
            <svg
              className={isDark ? '' : 'hidden'}
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
              className={isDark ? 'hidden' : ''}
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
          <button
            id="sidebar-toggle"
            type="button"
            className="sidebar-toggle-btn dashboard-header-icon-btn"
            aria-label="Open menu"
            onClick={toggleSidebar}
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
        </div>
      </div>
    </header>
  );
}
