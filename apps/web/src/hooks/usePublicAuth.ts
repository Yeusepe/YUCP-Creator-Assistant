import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { authClient } from '@/lib/auth-client';

export function usePublicAuth() {
  const sessionQuery = useQuery({
    queryKey: ['public-auth-session'],
    queryFn: async () => {
      const result = await authClient.getSession();
      return {
        isAuthenticated: Boolean(result.data?.session),
        authUserId:
          result.data?.user?.id ??
          (result.data?.session as { userId?: string } | undefined)?.userId,
      };
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
    isAuthenticated: sessionQuery.data?.isAuthenticated === true,
    authUserId: sessionQuery.data?.authUserId,
    signIn,
    signOut,
  };
}
