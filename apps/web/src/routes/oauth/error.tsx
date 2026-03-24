import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';

export const Route = createFileRoute('/oauth/error')({
  head: () => ({
    links: routeStylesheetLinks(routeStyleHrefs.oauthError),
  }),
  component: OAuthErrorPage,
});

function OAuthErrorPage() {
  const [errorDetail, setErrorDetail] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    if (error) {
      setErrorDetail(decodeURIComponent(error));
    }
  }, []);

  return (
    <div className="oauth-error-page">
      <div className="error-card">
        {/* icon */}
        <div className="icon-ring">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>

        <h1>Sign-in failed</h1>
        <p className="subtitle">
          Something went wrong during authorization. You can close this tab and try again.
        </p>

        {/* error detail -- shown only when ?error= param is present */}
        <div className={`detail-box${errorDetail ? ' visible' : ''}`} id="detail-box">
          <div className="detail-label">Error detail</div>
          <div className="detail-text" id="detail-text">
            {errorDetail}
          </div>
        </div>

        <div className="btn-row">
          <button type="button" className="btn btn-ghost" onClick={() => window.close()}>
            Close tab
          </button>
        </div>
      </div>
    </div>
  );
}
