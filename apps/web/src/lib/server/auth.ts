import { createServerFn } from '@tanstack/react-start';
import { getSession } from '../auth-server';
import { withWebServerRequestSpan } from './observability';

/**
 * Server function to read lightweight Better Auth session state from request
 * cookies without forcing the Convex token exchange used for authenticated SSR.
 */
export const getAuthSession = createServerFn({ method: 'GET' }).handler(async () => {
  return withWebServerRequestSpan(
    'serverFn.auth.session',
    {
      'tanstack.serverfn': 'getAuthSession',
    },
    async () => getSession()
  );
});
