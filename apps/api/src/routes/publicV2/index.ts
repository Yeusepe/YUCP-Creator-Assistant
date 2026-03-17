import { createLogger } from '@yucp/shared';
import { handleAuditLogRoutes } from './audit-log';
import { handleBindingsRoutes } from './bindings';
import { handleCollaboratorsRoutes } from './collaborators';
import { handleConnectionsRoutes } from './connections';
import { handleDownloadsRoutes } from './downloads';
import { handleEntitlementsRoutes } from './entitlements';
import { handleEventsRoutes } from './events';
import { handleGuildsRoutes } from './guilds';
import { errorResponse } from './helpers';
import { handleManualLicensesRoutes } from './manual-licenses';
import { handleMeRoutes } from './me';
import { handleOpenApiRoutes } from './openapi';
import { handleProductsRoutes } from './products';
import { handleRoleRulesRoutes } from './role-rules';
import { handleSettingsRoutes } from './settings';
import { handleSubjectsRoutes } from './subjects';
import { handleTransactionRoutes } from './transactions';
import type { PublicV2Config } from './types';
import { handleVerificationRoutes } from './verification';
import { handleVerificationSessionsRoutes } from './verification-sessions';
import { handleWebhooksRoutes } from './webhooks';

export type { PublicV2Config };

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const V2_PREFIX = '/api/public/v2';

export interface PublicV2Routes {
  handleRequest(request: Request, pathname: string): Promise<Response | null>;
}

export function createPublicV2Routes(config: PublicV2Config): PublicV2Routes {
  return {
    async handleRequest(request: Request, pathname: string): Promise<Response | null> {
      if (!pathname.startsWith(V2_PREFIX)) return null;

      // OPTIONS (CORS preflight) is handled by the outer layer
      if (request.method === 'OPTIONS') return null;

      const subPath = pathname.slice(V2_PREFIX.length) || '/';

      try {
        // OpenAPI spec — no auth required
        if (subPath === '/openapi.json') {
          return handleOpenApiRoutes(request, subPath, config);
        }

        // Identity
        if (subPath === '/me') {
          return handleMeRoutes(request, subPath, config);
        }

        // Subjects and sub-resources
        if (subPath.startsWith('/subjects')) {
          return handleSubjectsRoutes(request, subPath, config);
        }

        // Entitlements (standalone)
        if (subPath.startsWith('/entitlements')) {
          return handleEntitlementsRoutes(request, subPath, config);
        }

        // Transactions, memberships, and provider licenses share one handler
        if (
          subPath.startsWith('/transactions') ||
          subPath.startsWith('/memberships') ||
          subPath.startsWith('/provider-licenses')
        ) {
          return handleTransactionRoutes(request, subPath, config);
        }

        // Manual licenses
        if (subPath.startsWith('/manual-licenses')) {
          return handleManualLicensesRoutes(request, subPath, config);
        }

        // Products and sub-resources
        if (subPath.startsWith('/products')) {
          return handleProductsRoutes(request, subPath, config);
        }

        // Provider connections
        if (subPath.startsWith('/connections')) {
          return handleConnectionsRoutes(request, subPath, config);
        }

        // Guilds and sub-resources
        if (subPath.startsWith('/guilds')) {
          return handleGuildsRoutes(request, subPath, config);
        }

        // Role rules
        if (subPath.startsWith('/role-rules')) {
          return handleRoleRulesRoutes(request, subPath, config);
        }

        // Bindings
        if (subPath.startsWith('/bindings')) {
          return handleBindingsRoutes(request, subPath, config);
        }

        // Verification sessions
        if (subPath.startsWith('/verification-sessions')) {
          return handleVerificationSessionsRoutes(request, subPath, config);
        }

        // Collaborators
        if (subPath.startsWith('/collaborators')) {
          return handleCollaboratorsRoutes(request, subPath, config);
        }

        // Download routes and artifacts
        if (subPath.startsWith('/downloads')) {
          return handleDownloadsRoutes(request, subPath, config);
        }

        // Creator settings
        if (subPath === '/settings') {
          return handleSettingsRoutes(request, subPath, config);
        }

        // Platform events
        if (subPath.startsWith('/events')) {
          return handleEventsRoutes(request, subPath, config);
        }

        // Audit log
        if (subPath === '/audit-log') {
          return handleAuditLogRoutes(request, subPath, config);
        }

        // Webhooks and event type catalog
        if (subPath.startsWith('/webhooks') || subPath === '/webhook-event-types') {
          return handleWebhooksRoutes(request, subPath, config);
        }

        // Verification status / check
        if (subPath.startsWith('/verification')) {
          return handleVerificationRoutes(request, subPath, config);
        }

        return errorResponse('not_found', `No route matches ${request.method} ${pathname}`, 404);
      } catch (err) {
        logger.error('Unhandled error in publicV2 route handler', {
          pathname,
          error: String(err),
        });
        return errorResponse('internal_error', 'An internal error occurred', 500);
      }
    },
  };
}
