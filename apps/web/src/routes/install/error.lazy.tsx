import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
import { Icon } from '@/components/ui/Icon';
import '@/styles/install-result.css';

export const Route = createLazyFileRoute('/install/error')({
  component: InstallErrorPage,
});

const ERROR_MESSAGES: Record<string, string> = {
  installation_failed: 'We couldn’t finish installing the bot. This may be temporary.',
  invalid_state: 'This installation link has expired or has already been used. Start again.',
  bot_missing_permissions:
    'The bot needs the "Manage Roles" and "Send Messages" permissions to work correctly.',
  access_denied: 'You declined the bot installation. You can try again at any time.',
  unknown: 'We couldn’t finish the installation. Try again.',
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
      <BackgroundCanvasRoot position="fixed" />
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
            <Icon name="close" size={28} />
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
