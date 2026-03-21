import { useTheme } from '@/hooks/useTheme';

export interface DashboardHeaderProps {
  title: string;
  eyebrow?: string;
}

function toggleSidebar() {
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

export function DashboardHeader({ title, eyebrow }: DashboardHeaderProps) {
  const { isDark, toggleTheme } = useTheme();

  return (
    <header className="content-area-header animate-in relative z-10">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="min-w-0">
          {eyebrow && <div className="content-header-eyebrow">{eyebrow}</div>}
          <h1 className="content-header-title">{title}</h1>
        </div>
        <div className="content-header-actions flex items-center justify-end gap-3 w-full md:w-auto mt-4 md:mt-0">
          <button
            id="sidebar-toggle"
            type="button"
            className="sidebar-toggle-btn"
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
  );
}
