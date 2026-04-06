import { createLazyFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import '@/styles/install-result.css';

export const Route = createLazyFileRoute('/install/success')({
  component: InstallSuccessPage,
});

function InstallSuccessPage() {
  const { guild_id } = Route.useSearch();
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setIsVisible(true), 50);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="install-result-page">
      <div className={`install-result-content${isVisible ? ' is-visible' : ''}`}>
        <div className="install-result-card">
          <img
            src="/Icons/Bag.png"
            alt="Creator Assistant"
            className="install-result-logo"
            width="52"
            height="52"
          />

          <div className="install-result-icon install-result-icon--success" aria-hidden="true">
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
              <title>Installation succeeded</title>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>

          <h1 className="install-result-heading">Bot installed!</h1>
          <p className="install-result-body">
            Creator Assistant is now in your server. Connect storefronts, configure verification
            roles, and automate purchase checks from your creator dashboard.
          </p>

          <Link
            to="/dashboard"
            search={guild_id ? { guild_id } : {}}
            className="install-result-cta"
          >
            Open Creator Dashboard
          </Link>

          <p className="install-result-hint">You can manage all your servers from the sidebar.</p>
        </div>
      </div>
    </div>
  );
}
