import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react';
import { createFileRoute, Outlet, redirect, useRouteContext } from '@tanstack/react-router';
import { authClient } from '@/lib/auth-client';
import { getAuthToken } from '@/lib/server/auth';
import { loadProtectedAuthState, type ProtectedAuthState } from '@/lib/webDiagnostics';

let clientProtectedAuthCache: ProtectedAuthState | null = null;

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async (ctx) => {
    if (typeof window !== 'undefined' && clientProtectedAuthCache !== null) {
      return clientProtectedAuthCache;
    }

    const state = await loadProtectedAuthState({
      convexQueryClient: ctx.context.convexQueryClient,
      location: ctx.location,
      getAuthToken: () => getAuthToken(),
    });

    if (!state.isAuthenticated) {
      throw redirect({
        to: '/sign-in',
        search: { redirectTo: ctx.location.href },
      });
    }

    if (typeof window !== 'undefined') {
      clientProtectedAuthCache = state;
    }

    return state;
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const context = useRouteContext({ from: Route.id });

  return (
    <ConvexBetterAuthProvider
      client={context.convexQueryClient.convexClient}
      authClient={authClient}
      initialToken={context.token}
    >
      <Outlet />
    </ConvexBetterAuthProvider>
  );
}
