/**
 * Routes Index
 *
 * Exports all route handlers for the API.
 */

export {
  createVerificationRoutes,
  mountVerificationRouteHandlers,
  mountVerificationRoutes,
  type VerificationConfig,
  type VerificationRouteHandlers,
} from '../verification';
export { type ConnectConfig, createConnectRoutes } from './connect';
export {
  createInstallRoutes,
  type GuildLinkData,
  type GuildLinkStatus,
  type InstallConfig,
  type InstallRouteHandlers,
  mountInstallRoutes,
} from './install';
export { createProviderPlatformRoutes } from './providerPlatform';
export { createPublicRoutes, type PublicRouteConfig } from './public';
export { createWebhookHandler } from './webhooks';
