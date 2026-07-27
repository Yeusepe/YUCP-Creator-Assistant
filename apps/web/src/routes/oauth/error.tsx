import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
import { Icon } from '@/components/ui/Icon';
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
      <BackgroundCanvasRoot position="fixed" />
      <div className="error-card">
        {/* icon */}
        <div className="icon-ring">
          <Icon name="alert" />
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
