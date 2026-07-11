import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { CloudBackground } from '@/components/three/CloudBackground';
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
  const [redirectText, setRedirectText] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const panelToken = params.get('panelToken');
  const returnTo = params.get('returnTo');
  const safeReturnTo = getSafeReturnTo(returnTo);
  const deepLink = safeReturnTo
    ? safeReturnTo.replace(/^http(s)?:\/\/(ptb\.|canary\.)?discord\.com/, 'discord://-')
    : null;

  useEffect(() => {
    setIsVisible(true);

    if (panelToken) {
      fetch('/api/verification/panel/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ panelToken }),
      }).catch(() => {});
    }

    if (safeReturnTo && deepLink) {
      let count = 5;
      setRedirectText(`Redirecting in ${count} seconds...`);
      intervalRef.current = setInterval(() => {
        count--;
        if (count > 0) {
          setRedirectText(`Redirecting in ${count} second${count !== 1 ? 's' : ''}...`);
        } else {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setRedirectText('Redirecting...');
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
      <CloudBackground position="fixed" zIndex={-20} />
      <main className={`verify-success-page${isVisible ? ' is-visible' : ''}`}>
        <section className="verify-success-card">
          <div className="verify-success-eyebrow fade-up" style={{ animationDelay: '0.15s' }}>
            Verification complete
          </div>

          <div className="verify-success-icon-ring fade-up" style={{ animationDelay: '0.25s' }}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 7 10.5 16.5 6 12" />
            </svg>
          </div>

          <h1 className="verify-success-title fade-up" style={{ animationDelay: '0.35s' }}>
            You're verified
          </h1>

          <p className="verify-success-subtitle fade-up" style={{ animationDelay: '0.45s' }}>
            Your Discord roles will update shortly.
          </p>

          <div className="verify-success-status fade-up" style={{ animationDelay: '0.55s' }}>
            {redirectText ?? 'You can close this tab.'}
          </div>
        </section>
      </main>
    </div>
  );
}
