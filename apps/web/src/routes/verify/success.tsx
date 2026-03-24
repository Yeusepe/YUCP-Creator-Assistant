import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { routeStyleHrefs, routeStylesheetLinks } from '@/lib/routeStyles';

export const Route = createFileRoute('/verify/success')({
  head: () => ({
    meta: [{ title: 'Verification Successful | Creator Assistant' }],
    links: routeStylesheetLinks(routeStyleHrefs.verifySuccess),
  }),
  component: VerifySuccessPage,
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

function VerifySuccessPage() {
  const [redirectText, setRedirectText] = useState('Redirecting in 5 seconds...');
  const [isVisible, setIsVisible] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const panelToken = params.get('panelToken');
  const returnTo = params.get('returnTo');
  const safeReturnTo = getSafeReturnTo(returnTo);
  const deepLink = safeReturnTo
    ? safeReturnTo.replace(/^http(s)?:\/\/(ptb\.|canary\.)?discord\.com/, 'discord://-')
    : null;

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    window.close();
  }, []);

  useEffect(() => {
    setIsVisible(true);

    if (panelToken) {
      fetch('/api/verification/panel/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ panelToken }),
      }).catch(() => {});
    }

    if (typeof window !== 'undefined' && 'confetti' in window) {
      const confetti = (window as unknown as Record<string, unknown>).confetti as (
        opts: Record<string, unknown>
      ) => void;
      if (typeof confetti === 'function') {
        confetti({
          particleCount: 150,
          spread: 100,
          origin: { y: 0.6 },
          colors: ['#ffeb3b', '#0ea5e9', '#00e676', '#ffffff'],
          disableForReducedMotion: true,
        });
      }
    }

    if (safeReturnTo && deepLink) {
      let count = 5;
      intervalRef.current = setInterval(() => {
        count--;
        setRedirectText(
          count > 0
            ? `Redirecting to app in ${count} second${count !== 1 ? 's' : ''}...`
            : 'Redirecting...'
        );
        if (count <= 0) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          window.location.href = deepLink;
          setTimeout(() => {
            window.location.href = safeReturnTo;
          }, 2500);
        }
      }, 1000);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [panelToken, safeReturnTo, deepLink]);

  return (
    <div className="verify-success-page-wrapper">
      <main
        className={`verify-success-page text-center max-w-2xl w-full px-4 sm:px-6 relative z-10${isVisible ? ' is-visible' : ''}`}
      >
        <div className="success-checkmark">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <circle
              className="circle-path"
              cx="50"
              cy="50"
              r="45"
              stroke="#00e676"
              strokeWidth="6"
              fill="none"
            />
            <path
              className="check-path"
              d="M30 50 L45 65 L70 35"
              stroke="#00e676"
              strokeWidth="6"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h1
          className="text-4xl sm:text-6xl lg:text-7xl text-[#ffffff] mb-6 fade-up"
          style={{ animationDelay: '0.3s' }}
        >
          You're verified!
        </h1>
        <p
          className="text-lg sm:text-xl md:text-2xl text-[rgba(255,255,255,0.85)] mb-10 leading-relaxed fade-up"
          style={{ animationDelay: '0.5s' }}
        >
          Your Discord® account has been verified. Your roles will be updated shortly. You can
          return to Discord® now.
        </p>
        <div className="fade-up" style={{ animationDelay: '0.7s' }}>
          {safeReturnTo && deepLink ? (
            <>
              <a
                id="return-btn"
                href={deepLink}
                className="action-btn inline-block w-full sm:w-auto px-8 py-4 sm:px-12 sm:py-5 rounded-full text-lg sm:text-xl font-black uppercase tracking-widest no-underline mb-4"
              >
                Open Discord App
              </a>
              <br />
              <a
                id="return-web-btn"
                href={safeReturnTo}
                className="text-sm text-white/50 hover:text-white transition-colors underline underline-offset-4"
                style={{ fontFamily: "'Plus Jakarta Sans',sans-serif", fontWeight: 600 }}
              >
                Or continue in browser
              </a>
            </>
          ) : (
            <button
              id="return-btn"
              type="button"
              onClick={handleClose}
              className="action-btn inline-block w-full sm:w-auto px-8 py-4 sm:px-12 sm:py-5 rounded-full text-lg sm:text-xl font-black uppercase tracking-widest no-underline mb-4"
            >
              Close
            </button>
          )}
        </div>
        {safeReturnTo ? (
          <div
            id="redirect-msg"
            className="mt-12 text-sm font-bold uppercase tracking-widest opacity-40 fade-up"
            style={{ animationDelay: '0.9s' }}
          >
            {redirectText}
          </div>
        ) : (
          <div
            id="close-msg"
            className="mt-12 text-sm font-bold uppercase tracking-widest opacity-40 fade-up"
            style={{ animationDelay: '0.9s' }}
          >
            You can close this tab.
          </div>
        )}
      </main>
    </div>
  );
}
