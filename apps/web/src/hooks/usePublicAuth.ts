import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { authClient } from '@/lib/auth-client';

export function usePublicAuth() {
  const sessionQuery = useQuery({
    queryKey: ['public-auth-session'],
    queryFn: async () => {
      const result = await authClient.getSession();
      return Boolean(result.data?.session);
    },
    retry: false,
    staleTime: 30_000,
  });

  const signIn = useCallback(async (redirectTo?: string) => {
    await authClient.signIn.social({
      provider: 'discord',
      callbackURL: redirectTo ?? '/dashboard',
    });
  }, []);

  const signOut = useCallback(async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          location.reload();
        },
      },
    });
  }, []);

  return {
    isPending: sessionQuery.isPending,
    isAuthenticated: sessionQuery.data === true,
    signIn,
    signOut,
  };
}
