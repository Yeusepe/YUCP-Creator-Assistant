import { useCallback, useMemo } from 'react';
import { buildSignInUrlForRedirectTarget } from '@/lib/authUrls';
import { useRuntimeConfig } from '@/lib/runtimeConfig';

export function useAuth() {
  const { browserAuthBaseUrl } = useRuntimeConfig();
  const signInUrl = useMemo(() => {
    if (typeof window === 'undefined') return '#';
    const currentPath = window.location.pathname + window.location.search;
    return buildSignInUrlForRedirectTarget({
      browserAuthBaseUrl,
      redirectTo: currentPath,
    });
  }, [browserAuthBaseUrl]);

  const signOut = useCallback(async () => {
    await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
    window.location.href = '/sign-in';
  }, []);

  return { signInUrl, signOut };
}
