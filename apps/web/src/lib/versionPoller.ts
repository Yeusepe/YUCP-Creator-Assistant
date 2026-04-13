/**
 * useVersionPoller
 *
 * Polls GET /api/version every 5 minutes while the browser tab is visible.
 * When the server's buildId differs from the value baked in at build time,
 * fires a persistent toast notification prompting the user to reload.
 *
 * Pattern: Linear-style "Update available" banner, non-blocking, user stays
 * in control and can reload when convenient.
 */

import { useEffect, useRef } from 'react';
import { useToast } from '@/components/ui/Toast';

/** Build ID injected by Vite at bundle time. Falls back to 'dev'. */
const CURRENT_BUILD_ID: string =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: { VITE_BUILD_ID?: string } }).env?.VITE_BUILD_ID) ||
  'dev';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const VERSION_ENDPOINT = '/api/version';

interface VersionResponse {
  buildId: string;
}

async function fetchBuildId(): Promise<string | null> {
  try {
    const res = await fetch(VERSION_ENDPOINT, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data: VersionResponse = await res.json();
    return data.buildId ?? null;
  } catch {
    return null;
  }
}

export function useVersionPoller(): void {
  const toast = useToast();
  const notifiedRef = useRef(false);

  useEffect(() => {
    // Skip in dev mode, build IDs would always be 'dev'
    if (CURRENT_BUILD_ID === 'dev') return;

    async function check() {
      if (notifiedRef.current) return;
      if (document.visibilityState !== 'visible') return;

      const serverBuildId = await fetchBuildId();
      if (!serverBuildId) return;
      if (serverBuildId === CURRENT_BUILD_ID) return;

      notifiedRef.current = true;

      toast.info('A new version is available', {
        duration: 0, // persistent, user must act
        description: 'Reload to get the latest version.',
        action: {
          label: 'Reload',
          onClick: () => {
            window.location.reload();
          },
        },
      });
    }

    // Poll on an interval
    const interval = setInterval(check, POLL_INTERVAL_MS);

    // Also check immediately when the tab becomes visible after being hidden
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        check();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [toast]);
}
