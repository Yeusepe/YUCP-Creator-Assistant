import { createLazyFileRoute } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
import { buildSetupAuthQuery } from '@/lib/setupAuth';
import { resolveSetupApiBase } from '../../setup/-lemonsqueezySetupSupport';

export const Route = createLazyFileRoute('/oauth/callback/itchio')({
  component: ItchioSetupPage,
});

function getUrlParams(): {
  tenantId: string;
  guildId: string;
  apiBase: string;
} {
  if (typeof window === 'undefined') {
    return { tenantId: '', guildId: '', apiBase: '' };
  }
  const params = new URLSearchParams(window.location.search);
  const resolveApiBase = (raw: string | null) => resolveSetupApiBase(raw, window.location.origin);
  return {
    tenantId: params.get('tenant_id') || params.get('tenantId') || '',
    guildId: params.get('guild_id') || params.get('guildId') || '',
    apiBase: resolveApiBase(params.get('api_base')),
  };
}

async function bootstrapSetupSession(apiBase: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const setupToken = hash.get('s');
  const accessToken = hash.get('access_token');
  if (!setupToken || accessToken) return false;

  const response = await fetch(`${apiBase}/api/connect/bootstrap`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken }),
  });
  if (!response.ok) {
    const errorUrl = new URL(`${apiBase}/verify-error`, window.location.origin);
    errorUrl.searchParams.set('error', 'link_expired');
    window.location.replace(errorUrl.toString());
    return true;
  }
  window.history.replaceState({}, '', window.location.pathname + window.location.search);
  window.location.reload();
  return true;
}

type Phase = 'redirecting' | 'processing' | 'error';

function isCreatorSetupCallback(state: string | null, tenantId: string, guildId: string) {
  return state?.startsWith('connect_itchio:') === true || Boolean(tenantId || guildId);
}

function getUserFacingItchioCallbackError(error: string | null | undefined): string {
  if (!error) {
    return 'Could not finish itch.io callback.';
  }

  const normalized = error.trim().toLowerCase();
  if (
    normalized === 'invalid_state' ||
    normalized === 'invalid state parameter' ||
    normalized === 'session not found or expired'
  ) {
    return 'This itch.io link expired or was already used. Restart verification and try again.';
  }

  if (
    normalized.startsWith('verification mode does not support implicit callback') ||
    normalized.startsWith('provider does not support implicit account linking') ||
    normalized.startsWith('unknown verification mode')
  ) {
    return 'This itch.io return link is no longer supported. Start the verification flow again from the latest YUCP screen.';
  }

  return error;
}

function useSimulatedProgress(phase: Phase): number {
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (phase === 'error') {
      setProgress(0);
      return;
    }

    const target = phase === 'processing' ? 90 : 70;
    const duration = phase === 'processing' ? 6000 : 1200;

    function tick(now: number) {
      if (startRef.current === null) startRef.current = now;
      const elapsed = now - startRef.current;
      const t = Math.min(elapsed / duration, 1);
      // ease-out curve
      const eased = 1 - (1 - t) * (1 - t);
      setProgress(Math.round(eased * target));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }

    startRef.current = null;
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [phase]);

  return progress;
}

function ItchioSetupPage() {
  const { tenantId, guildId, apiBase } = getUrlParams();
  const [phase, setPhase] = useState<Phase>('redirecting');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const rawProgress = useSimulatedProgress(phase);
  const progress = done ? 100 : rawProgress;

  const dashboardUrl = useMemo(() => {
    if (typeof window === 'undefined') return '/dashboard';
    const url = new URL(`${apiBase}/dashboard`, window.location.origin);
    if (tenantId) url.searchParams.set('tenant_id', tenantId);
    if (guildId) url.searchParams.set('guild_id', guildId);
    return url.toString();
  }, [apiBase, guildId, tenantId]);

  const beginUrl = useMemo(() => {
    if (typeof window === 'undefined') return '/api/connect/itchio/begin';
    const path = buildSetupAuthQuery('/api/connect/itchio/begin', tenantId);
    const url = new URL(`${apiBase}${path}`, window.location.origin);
    if (guildId) url.searchParams.set('guildId', guildId);
    return url.toString();
  }, [apiBase, guildId, tenantId]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const bootstrapped = await bootstrapSetupSession(apiBase).catch(() => false);
      if (bootstrapped || cancelled || typeof window === 'undefined') return;

      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const accessToken = hash.get('access_token');
      const state = hash.get('state');
      const oauthError = hash.get('error');
      const oauthErrorDescription = hash.get('error_description');
      const creatorSetupCallback = isCreatorSetupCallback(state, tenantId, guildId);

      if (oauthError) {
        window.history.replaceState({}, '', window.location.pathname + window.location.search);
        if (!cancelled) {
          setPhase('error');
          setError(oauthErrorDescription ?? oauthError);
        }
        return;
      }

      if (!accessToken || !state) {
        if (creatorSetupCallback) {
          setPhase('redirecting');
          window.location.replace(beginUrl);
          return;
        }
        setPhase('error');
        setError('Missing itch.io authorization response.');
        return;
      }

      setPhase('processing');
      setError(null);
      window.history.replaceState({}, '', window.location.pathname + window.location.search);

      const finishPath = creatorSetupCallback
        ? '/api/connect/itchio/finish'
        : '/api/verification/finish/itchio';
      const response = await fetch(`${apiBase}${finishPath}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken, state }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        redirectUrl?: string;
      };

      if (!response.ok || !data.success || !data.redirectUrl) {
        if (!cancelled) {
          setPhase('error');
          setError(
            getUserFacingItchioCallbackError(
              data.error ??
                (creatorSetupCallback
                  ? 'Could not finish itch.io setup.'
                  : 'Could not finish itch.io verification.')
            )
          );
        }
        return;
      }

      if (cancelled) return;
      setDone(true);
      setTimeout(() => {
        window.location.replace(data.redirectUrl ?? dashboardUrl);
      }, 300);
    }

    run().catch((caughtError) => {
      if (!cancelled) {
        setPhase('error');
        setError(
          getUserFacingItchioCallbackError(
            caughtError instanceof Error
              ? caughtError.message
              : 'Could not finish itch.io callback.'
          )
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [apiBase, beginUrl, dashboardUrl, guildId, tenantId]);

  const statusText =
    phase === 'processing' ? 'Finalizing your connection...' : 'Redirecting to itch.io...';

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#0b0b10] text-white">
      <BackgroundCanvasRoot position="fixed" />

      {phase === 'error' ? (
        <div className="relative z-10 w-full max-w-sm rounded-2xl border border-white/10 bg-black/40 p-8 text-center backdrop-blur-xl">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-widest text-red-400/80">
            Connection error
          </p>
          <h1 className="mt-1 text-xl font-semibold text-white">itch.io</h1>
          <p className="mt-3 text-sm leading-6 text-white/60">
            {error ?? 'Could not finish itch.io setup.'}
          </p>
          <a
            href={dashboardUrl}
            className="mt-6 inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            style={{ textDecoration: 'none' }}
          >
            <ArrowLeft size={14} />
            Back to dashboard
          </a>
        </div>
      ) : (
        <div className="relative z-10 w-full max-w-sm rounded-2xl border border-white/10 bg-black/40 px-8 py-7 text-center backdrop-blur-xl">
          <p className="text-[11px] font-bold uppercase tracking-widest text-white/40">
            {phase === 'processing' ? 'Connecting' : 'Redirecting'}
          </p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-white">itch.io</h1>

          {/* Progress bar */}
          <div className="relative mt-6 h-1 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-[#fa5c5c] transition-[width] duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>

          <p className="mt-4 text-xs text-white/40">{statusText}</p>
        </div>
      )}
    </div>
  );
}
