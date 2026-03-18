import { convexBetterAuthReactStart } from '@convex-dev/better-auth/react-start';

/**
 * Server-side auth utilities for TanStack Start.
 *
 * - `handler`: Proxies /api/auth/* requests to Convex
 * - `getToken`: Gets JWT from session cookies (for SSR auth in beforeLoad)
 * - `fetchAuthQuery/Mutation/Action`: Call Convex functions with auth from server fns
 *
 * Ref: https://labs.convex.dev/better-auth/framework-guides/tanstack-start
 */
export const { handler, getToken, fetchAuthQuery, fetchAuthMutation, fetchAuthAction } =
  convexBetterAuthReactStart({
    convexUrl: process.env.VITE_CONVEX_URL ?? '',
    convexSiteUrl: process.env.VITE_CONVEX_SITE_URL ?? '',
  });
