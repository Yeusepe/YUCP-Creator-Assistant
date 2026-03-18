import { useCallback, useMemo } from 'react';

export function useAuth() {
  const signInUrl = useMemo(() => {
    if (typeof window === 'undefined') return '#';
    const origin = window.location.origin;
    const currentPath = window.location.pathname + window.location.search;
    const callbackUrl = `${origin}/sign-in-redirect?redirectTo=${encodeURIComponent(currentPath)}`;
    return `/api/auth/sign-in/discord?callbackURL=${encodeURIComponent(callbackUrl)}`;
  }, []);

  const signOut = useCallback(async () => {
    await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
    window.location.href = '/sign-in';
  }, []);

  return { signInUrl, signOut };
}
