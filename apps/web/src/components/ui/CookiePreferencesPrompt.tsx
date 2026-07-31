import { useEffect, useState } from 'react';
import { YucpButton } from '@/components/ui/YucpButton';
import {
  getPrivacyPreferenceSummary,
  PRIVACY_PREFERENCES_EVENT,
  type PrivacyPreferences,
  readStoredPrivacyPreferences,
  savePrivacyPreferences,
} from '@/lib/privacyPreferences';

// This banner renders on every route, including the public ones that carry no
// Convex auth provider, so it records nothing itself: PrivacyConsentSync listens
// for the same preference event inside the authenticated tree and writes there.
function usePrivacyPreferencesState() {
  const [preferences, setPreferences] = useState<PrivacyPreferences | null>(null);
  const [ready, setReady] = useState(false);

  function remember(next: PrivacyPreferences) {
    setPreferences(next);
    return next;
  }

  useEffect(() => {
    setPreferences(readStoredPrivacyPreferences());
    setReady(true);

    function syncFromStorage() {
      setPreferences(readStoredPrivacyPreferences());
    }

    function handleCustomEvent(event: Event) {
      const detail = (event as CustomEvent<PrivacyPreferences>).detail;
      if (detail) {
        setPreferences(detail);
        return;
      }
      syncFromStorage();
    }

    window.addEventListener('storage', syncFromStorage);
    window.addEventListener(PRIVACY_PREFERENCES_EVENT, handleCustomEvent);
    return () => {
      window.removeEventListener('storage', syncFromStorage);
      window.removeEventListener(PRIVACY_PREFERENCES_EVENT, handleCustomEvent);
    };
  }, []);

  return {
    preferences,
    ready,
    setNecessaryOnly: () => remember(savePrivacyPreferences('necessary-only', 'banner')),
    setHelpfulDiagnostics: () => remember(savePrivacyPreferences('helpful-diagnostics', 'banner')),
  };
}

export function CookiePreferencesPrompt() {
  const { preferences, ready, setNecessaryOnly, setHelpfulDiagnostics } =
    usePrivacyPreferencesState();

  if (!ready || preferences) {
    return null;
  }

  const preview = getPrivacyPreferenceSummary(preferences);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[1100] p-4 sm:p-6">
      <div
        className="pointer-events-auto mx-auto max-w-3xl rounded-[28px] border border-slate-200/90 bg-white/95 p-5 text-slate-900 shadow-[0_30px_90px_rgba(15,23,42,0.18)] backdrop-blur dark:border-slate-700/80 dark:bg-slate-950/92 dark:text-slate-100"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cookie-preferences-title"
      >
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl space-y-3">
            <div className="inline-flex items-center rounded-full bg-sky-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-700 dark:bg-sky-500/15 dark:text-sky-200">
              Privacy choices
            </div>
            <div className="space-y-2">
              <h2 id="cookie-preferences-title" className="text-2xl font-bold tracking-[-0.03em]">
                Your privacy, your choice
              </h2>
              <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">
                We always use necessary first-party cookies for sign-in, setup, and security. You
                can also allow <strong>helpful diagnostics</strong> so bug reports and slow-page
                issues are easier to debug with anonymous error, performance, and session
                diagnostics. No ads. No resale. No cross-site profiling.
              </p>
            </div>
            <div className="rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-200">
              <p className="cookie-preferences-summary-title">{preview.title}</p>
              <p className="mt-1">{preview.description}</p>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                You can review or change this later in{' '}
                <a href="/account/privacy" className="underline underline-offset-2">
                  Account Privacy
                </a>
                .
              </p>
            </div>
          </div>

          <div className="flex w-full flex-col gap-3 sm:w-auto sm:min-w-[230px]">
            <YucpButton
              yucp="primary"
              pill
              className="btn-primary--diagnostics w-full justify-center"
              onClick={() => setHelpfulDiagnostics()}
            >
              Allow helpful diagnostics
            </YucpButton>
            <YucpButton
              yucp="secondary"
              className="btn-ghost--diagnostics w-full justify-center"
              onClick={() => setNecessaryOnly()}
            >
              Only necessary
            </YucpButton>
            <a
              href="/legal/privacy-policy"
              className="text-center text-xs font-medium text-slate-500 underline underline-offset-2 dark:text-slate-400"
            >
              Read the privacy policy
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
