import { createServerFn } from '@tanstack/react-start';
import { getToken } from '../auth-server';

/**
 * Server function to get the current auth token during SSR.
 * Used in route `beforeLoad` hooks for SSR auth and route protection.
 */
export const getAuth = createServerFn({ method: 'GET' }).handler(async () => {
  return await getToken();
});
