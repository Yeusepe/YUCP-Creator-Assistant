import { type AuthClient, ConvexBetterAuthProvider } from '@convex-dev/better-auth/react';
import { createFileRoute, Outlet, redirect, useRouteContext } from '@tanstack/react-router';
import { authClient } from '@/lib/auth-client';
import { getAuthSession } from '@/lib/server/auth';
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
      getAuthSession: () => getAuthSession(),
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
  // Better Auth 1.6.23 correctly infers the concrete heterogeneous plugin
  // tuple, while the Convex provider exposes an older homogeneous union for
  // the same runtime client protocol. Keep the compatibility assertion at the
  // provider boundary rather than weakening the exported auth client type.
  const convexAuthClient = authClient as unknown as AuthClient;

  return (
    <ConvexBetterAuthProvider
      client={context.convexQueryClient.convexClient}
      authClient={convexAuthClient}
      initialToken={context.token ?? undefined}
    >
      <Outlet />
    </ConvexBetterAuthProvider>
  );
}
