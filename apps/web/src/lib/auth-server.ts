import { convexBetterAuthReactStart } from '@convex-dev/better-auth/react-start';

/**
 * Server-side auth utilities for TanStack Start.
 *
 * - `handler`: Proxies /api/auth/* requests to Convex
 * - `getToken`: Gets JWT from session cookies (for SSR auth in beforeLoad)
 * - `fetchAuthQuery/Mutation/Action`: Call Convex functions with auth from server fns
 *
 * Env vars CONVEX_URL and CONVEX_SITE_URL come from Infisical bootstrap.
 * Ref: https://labs.convex.dev/better-auth/framework-guides/tanstack-start
 */
export const { handler, getToken, fetchAuthQuery, fetchAuthMutation, fetchAuthAction } =
  convexBetterAuthReactStart({
    convexUrl: process.env.CONVEX_URL ?? '',
    convexSiteUrl: process.env.CONVEX_SITE_URL ?? '',
  });
