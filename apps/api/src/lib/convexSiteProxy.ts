import type { LocalEnv } from './env';

export function getConfiguredConvexSiteUrlForProxy(env: Pick<LocalEnv, 'CONVEX_SITE_URL'>): string {
  const convexSiteUrl = env.CONVEX_SITE_URL;
  if (!convexSiteUrl) {
    throw new Error('CONVEX_SITE_URL must be set for Convex auth proxying');
  }
  return convexSiteUrl.replace(/\/$/, '');
}
