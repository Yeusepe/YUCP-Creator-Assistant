import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
import '@/styles/install-result.css';

export const Route = createFileRoute('/install/error')({
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === 'string' ? search.error : 'unknown',
  }),
  component: InstallErrorPage,
});

const ERROR_MESSAGES: Record<string, string> = {
  installation_failed:
    'The bot installation could not be completed. This may be a temporary issue.',
  invalid_state: 'The installation link expired or was already used. Please start over.',
  bot_missing_permissions:
    'The bot needs the "Manage Roles" and "Send Messages" permissions to work correctly.',
  access_denied: 'You declined the bot installation. You can try again at any time.',
  unknown: 'Something went wrong during installation. Please try again.',
};

function InstallErrorPage() {
  const { error } = Route.useSearch();
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setIsVisible(true), 50);
    return () => clearTimeout(t);
  }, []);

  const message = ERROR_MESSAGES[error] ?? ERROR_MESSAGES.unknown;

  return (
    <div className="install-result-page">
      <BackgroundCanvasRoot />
      <div className={`install-result-content${isVisible ? ' is-visible' : ''}`}>
        <div className="install-result-card">
          <img
            src="/Icons/Bag.png"
            alt="Creator Assistant"
            className="install-result-logo"
            width="52"
            height="52"
          />

          <div className="install-result-icon install-result-icon--error" aria-hidden="true">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <title>Installation failed</title>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </div>

          <h1 className="install-result-heading">Installation failed</h1>
          <p className="install-result-body">{message}</p>

          <Link to="/account" className="install-result-cta">
            Back to My Account
          </Link>
        </div>
      </div>
    </div>
  );
}
