/**
 * Routes Index
 *
 * Exports all route handlers for the API.
 */

export {
  createInstallRoutes,
  mountInstallRoutes,
  type InstallConfig,
  type InstallRouteHandlers,
  type GuildLinkData,
  type GuildLinkStatus,
} from './install';
export {
  createVerificationRoutes,
  mountVerificationRoutes,
  type VerificationConfig,
  type VerificationRouteHandlers,
} from '../verification';
export { createConnectRoutes, type ConnectConfig } from './connect';
export { createPublicRoutes, type PublicRouteConfig } from './public';
export { createWebhookHandler } from './webhooks';
