import { createLazyFileRoute } from '@tanstack/react-router';
import { ArrowLeft, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { BackgroundCanvasRoot } from '@/components/page/BackgroundCanvasRoot';
import { buildSetupAuthQuery } from '@/lib/setupAuth';
import { resolveSetupApiBase } from '../../setup/lemonsqueezySetupSupport';

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

function ItchioSetupPage() {
  const { tenantId, guildId, apiBase } = getUrlParams();
  const [phase, setPhase] = useState<Phase>('redirecting');
  const [error, setError] = useState<string | null>(null);

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
            data.error ??
              (creatorSetupCallback
                ? 'Could not finish itch.io setup.'
                : 'Could not finish itch.io verification.')
          );
        }
        return;
      }

      if (cancelled) return;
      window.location.replace(data.redirectUrl ?? dashboardUrl);
    }

    run().catch((caughtError) => {
      if (!cancelled) {
        setPhase('error');
        setError(
          caughtError instanceof Error ? caughtError.message : 'Could not finish itch.io callback.'
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [apiBase, beginUrl, dashboardUrl, guildId, tenantId]);

  const statusCopy =
    phase === 'processing'
      ? 'Finalizing your itch.io connection...'
      : phase === 'redirecting'
        ? 'Redirecting to itch.io...'
        : (error ?? 'Could not finish itch.io setup.');

  return (
    <div className="fixed inset-0 overflow-y-auto overflow-x-hidden bg-[#0b0b10] text-white">
      <div className="relative flex min-h-screen items-center justify-center px-6 py-16">
        <BackgroundCanvasRoot position="absolute" />
        <div className="absolute top-10 left-10 h-64 w-64 rounded-full border border-white/5 pointer-events-none animate-[spin_60s_linear_infinite]" />
        <div className="absolute right-10 bottom-10 h-96 w-96 rounded-full border border-[#fa5c5c]/5 pointer-events-none animate-[spin_80s_linear_infinite_reverse]" />

        <div className="relative z-10 w-full max-w-md rounded-[32px] border border-white/10 bg-black/30 p-8 text-center shadow-[0_20px_60px_-15px_rgba(0,0,0,0.3)] backdrop-blur-xl">
          {phase === 'error' ? (
            <>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-red-400/20 bg-red-400/10 px-3 py-1 text-[11px] font-black uppercase tracking-[0.12em] text-white/80">
                Connection error
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-white">itch.io</h1>
              <p className="mt-3 text-sm leading-6 text-white/65">{statusCopy}</p>
              <a
                href={dashboardUrl}
                className="mt-6 inline-flex items-center justify-center gap-2 rounded-[10px] border border-white/10 bg-white/5 px-5 py-2.5 text-sm font-semibold text-white/80 transition-all hover:bg-white/10 hover:text-white"
                style={{ textDecoration: 'none' }}
              >
                <ArrowLeft size={14} />
                Back to dashboard
              </a>
            </>
          ) : (
            <>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[#fa5c5c]/20 bg-[#fa5c5c]/10 px-3 py-1 text-[11px] font-black uppercase tracking-[0.12em] text-white/80">
                {phase === 'processing' ? 'Connecting' : 'Redirecting'}
              </div>
              <LoaderCircle
                className="mx-auto h-10 w-10 animate-spin text-[#fa5c5c]"
                aria-hidden="true"
              />
              <h1 className="mt-4 text-3xl font-bold tracking-tight text-white">itch.io</h1>
              <p className="mt-3 text-sm leading-6 text-white/65">{statusCopy}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
