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
export { createAccountSecurityRoutes } from './accountSecurity';
export { type ConnectConfig, createConnectRoutes } from './connect';
export { type CreatorUploadConfig, createCreatorUploadRoutes } from './creatorUploads';
export { createForensicsRoutes, type ForensicsConfig } from './forensics';
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
