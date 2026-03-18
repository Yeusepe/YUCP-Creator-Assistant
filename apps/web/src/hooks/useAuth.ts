import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { authClient } from '@/lib/auth-client';

export function useAuth() {
  const navigate = useNavigate();
  const session = authClient.useSession();

  const signIn = useCallback(async (redirectTo?: string) => {
    await authClient.signIn.social({
      provider: 'discord',
      callbackURL: redirectTo ?? '/dashboard',
    });
  }, []);

  const signOut = useCallback(async () => {
    await authClient.signOut();
    navigate({ to: '/sign-in', search: { redirectTo: undefined }, replace: true });
  }, [navigate]);

  return {
    session: session.data,
    isPending: session.isPending,
    isAuthenticated: !!session.data?.user,
    signIn,
    signOut,
  };
}
