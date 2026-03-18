import { useCallback, useMemo } from 'react';
import { buildDiscordSignInUrl } from '@/lib/authUrls';
import { useRuntimeConfig } from '@/lib/runtimeConfig';

export function useAuth() {
  const { browserAuthBaseUrl } = useRuntimeConfig();
  const signInUrl = useMemo(() => {
    if (typeof window === 'undefined') return '#';
    const currentPath = window.location.pathname + window.location.search;
    const callbackUrl = new URL('/sign-in-redirect', browserAuthBaseUrl);
    callbackUrl.searchParams.set('redirectTo', currentPath);
    return buildDiscordSignInUrl(callbackUrl.toString());
  }, [browserAuthBaseUrl]);

  const signOut = useCallback(async () => {
    await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
    window.location.href = '/sign-in';
  }, []);

  return { signInUrl, signOut };
}
