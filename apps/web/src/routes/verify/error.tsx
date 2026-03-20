import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
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
  if (!error) return 'Verification could not be completed.';
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
      <BackgroundCanvasRoot />
      <main
        className={`verify-error-page text-center max-w-2xl w-full px-4 sm:px-6 relative z-10${isVisible ? ' is-visible' : ''}`}
      >
        <div className="mb-8 fade-up" style={{ animationDelay: '0.2s' }}>
          <svg
            className="w-24 h-24 mx-auto text-[#c53030]"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h1
          className="text-4xl sm:text-5xl lg:text-6xl text-[#ffffff] mb-6 fade-up"
          style={{ animationDelay: '0.3s' }}
        >
          Something went wrong
        </h1>
        <p
          id="error-msg"
          className="text-lg sm:text-xl md:text-2xl text-[rgba(255,255,255,0.85)] mb-10 leading-relaxed fade-up"
          style={{ animationDelay: '0.5s' }}
        >
          {errorMessage}
        </p>
        <div className="fade-up" style={{ animationDelay: '0.7s' }}>
          {safeReturnTo ? (
            <a
              id="return-btn"
              href={safeReturnTo}
              className="action-btn inline-block w-full sm:w-auto px-8 py-4 sm:px-12 sm:py-5 rounded-full text-lg sm:text-xl font-black uppercase tracking-widest no-underline"
            >
              Return to Discord®
            </a>
          ) : (
            <button
              id="return-btn"
              type="button"
              onClick={handleGoBack}
              className="action-btn inline-block w-full sm:w-auto px-8 py-4 sm:px-12 sm:py-5 rounded-full text-lg sm:text-xl font-black uppercase tracking-widest no-underline"
            >
              Try Again
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
