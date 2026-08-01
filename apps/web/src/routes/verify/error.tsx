import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
import { Icon } from '@/components/ui/Icon';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';

export const Route = createFileRoute('/verify/error')({
  head: () => ({
    meta: [{ title: 'Verification Failed | Creator Assistant' }],
    links: routeStylesheetLinks(routeStyleHrefs.verifyError),
  }),
  component: VerifyErrorPage,
});

function getSafeReturnTo(value: string | null): string | null {
  if (!value || typeof window === 'undefined') return null;
  try {
    const url = new URL(value, window.location.origin);
    const allowedOrigins = new Set([
      'https://discord.com',
      'https://ptb.discord.com',
      'https://canary.discord.com',
      window.location.origin,
    ]);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    if (!allowedOrigins.has(url.origin)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeError(error: string | null): string {
  if (!error) return 'We couldn’t complete verification.';
  const normalized = error
    .replace(/^link_expired$/i, 'This link has expired')
    .replace(/^missing_parameters$/i, 'Missing parameters')
    .replace(/^internal_error$/i, 'An internal error occurred')
    .replace(/_/g, ' ');
  return normalized;
}

function VerifyErrorPage() {
  const [isVisible, setIsVisible] = useState(false);

  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const error = params.get('error');
  const returnTo = params.get('returnTo');
  const safeReturnTo = getSafeReturnTo(returnTo);
  const errorMessage = useMemo(() => normalizeError(error), [error]);

  const handleGoBack = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    window.history.back();
  }, []);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  return (
    <div className="verify-error-page-wrapper">
      <BackgroundCanvasRoot position="fixed" />
      <main
        className={`verify-error-page text-center max-w-lg w-full px-4 sm:px-6 relative z-10${isVisible ? ' is-visible' : ''}`}
      >
        <div className="mb-6 fade-up" style={{ animationDelay: '0.2s' }}>
          <Icon name="alert" className="w-16 h-16 mx-auto text-[#c53030]" />
        </div>
        <h1
          className="text-3xl sm:text-4xl text-[#ffffff] mb-4 fade-up"
          style={{ animationDelay: '0.3s' }}
        >
          Something went wrong
        </h1>
        <p
          id="error-msg"
          className="text-base text-[rgba(255,255,255,0.72)] mb-8 leading-relaxed fade-up"
          style={{ animationDelay: '0.5s' }}
        >
          {errorMessage}
        </p>
        <div className="fade-up" style={{ animationDelay: '0.7s' }}>
          {safeReturnTo ? (
            <a
              id="return-btn"
              href={safeReturnTo}
              className="action-btn inline-block px-7 py-3 rounded-full text-sm font-bold uppercase tracking-widest no-underline"
            >
              Return to Discord
            </a>
          ) : (
            <button
              id="return-btn"
              type="button"
              onClick={handleGoBack}
              className="action-btn inline-block px-7 py-3 rounded-full text-sm font-bold uppercase tracking-widest no-underline"
            >
              Try Again
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
