import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { logger } from '../../lib/logger';
import { resolveAuth } from './auth';
import {
  errorResponse,
  extractListData,
  generateRequestId,
  jsonResponse,
  listResponse,
  parsePagination,
} from './helpers';
import type { PublicV2Config } from './types';

/**
 * Hash a license key with HMAC-SHA256 keyed by the server encryption secret.
 * Using a server-side key prevents offline dictionary attacks if the database
 * is ever leaked, an attacker would also need the secret to brute-force keys.
 *
 * NOTE: Changing this function invalidates all previously stored hashes.
 * Existing license keys must be re-imported after deploying this change.
 */
async function hashLicenseKey(key: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(key));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function handleManualLicensesRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();
  const url = new URL(request.url);
  const convex = getConvexClientFromUrl(config.convexUrl);

  // POST /manual-licenses/bulk, must check before /:id
  if (subPath === '/manual-licenses/bulk') {
    if (request.method !== 'POST') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['licenses:manage'], reqId);
    if (auth instanceof Response) return auth;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return errorResponse('bad_request', 'Invalid JSON body', 400, reqId);
    }

    const licenses = body.licenses;
    if (!Array.isArray(licenses) || licenses.length === 0) {
      return errorResponse('bad_request', 'licenses must be a non-empty array', 400, reqId);
    }
    if (licenses.length > 100) {
      return errorResponse('bad_request', 'Maximum of 100 licenses per bulk request', 400, reqId);
    }

    try {
      const hashedLicenses = await Promise.all(
        licenses.map(async (lic: Record<string, unknown>) => ({
          ...lic,
          hashedKey: lic.key
            ? await hashLicenseKey(lic.key as string, config.encryptionSecret)
            : undefined,
          key: undefined,
        }))
      );

      const result = await convex.mutation(api.manualLicenses.bulkCreate, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        licenses: hashedLicenses,
      });
      return jsonResponse(result, 201, reqId);
    } catch (err) {
      logger.error('manualLicenses.bulkCreate failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // POST /manual-licenses/validate, must check before /:id
  if (subPath === '/manual-licenses/validate') {
    if (request.method !== 'POST') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['licenses:manage'], reqId);
    if (auth instanceof Response) return auth;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return errorResponse('bad_request', 'Invalid JSON body', 400, reqId);
    }

    if (typeof body.key !== 'string' || !body.key) {
      return errorResponse('bad_request', 'key is required', 400, reqId);
    }

    try {
      const hashedKey = await hashLicenseKey(body.key as string, config.encryptionSecret);
      const result = await convex.query(api.manualLicenses.validateByHash, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        hashedKey,
        productId: body.product_id as string | undefined,
      });
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('manualLicenses.validateByHash failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // GET /manual-licenses/stats, must check before /:id
  if (subPath === '/manual-licenses/stats' && request.method === 'GET') {
    const auth = await resolveAuth(request, config, ['licenses:manage'], reqId);
    if (auth instanceof Response) return auth;

    try {
      const result = await convex.query(api.manualLicenses.getStats, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
      });
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('manualLicenses.getStats failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // POST /manual-licenses/:id/revoke
  const revokeMatch = subPath.match(/^\/manual-licenses\/([^/]+)\/revoke$/);
  if (revokeMatch) {
    if (request.method !== 'POST') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['licenses:manage'], reqId);
    if (auth instanceof Response) return auth;

    const licenseId = revokeMatch[1];
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // body is optional
    }

    try {
      const result = await convex.mutation(api.manualLicenses.revoke, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        licenseId,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      });
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('manualLicenses.revoke failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // GET + POST /manual-licenses
  if (subPath === '/manual-licenses') {
    if (request.method === 'GET') {
      const auth = await resolveAuth(request, config, ['licenses:manage'], reqId);
      if (auth instanceof Response) return auth;

      const { limit, cursor } = parsePagination(url);
      const productId = url.searchParams.get('product_id') ?? undefined;
      const status = url.searchParams.get('status') ?? undefined;

      try {
        const result = await convex.query(api.manualLicenses.listByTenant, {
          apiSecret: config.convexApiSecret,
          authUserId: auth.authUserId,
          productId,
          status,
          cursor,
          limit,
        });
        const { data, hasMore, nextCursor } = extractListData(result);
        return listResponse(data, hasMore, nextCursor, reqId);
      } catch (err) {
        logger.error('manualLicenses.listByTenant failed', { error: String(err) });
        return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
      }
    }

    if (request.method === 'POST') {
      const auth = await resolveAuth(request, config, ['licenses:manage'], reqId);
      if (auth instanceof Response) return auth;

      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return errorResponse('bad_request', 'Invalid JSON body', 400, reqId);
      }

      if (typeof body.key !== 'string' || !body.key) {
        return errorResponse('bad_request', 'key is required', 400, reqId);
      }
      if (typeof body.product_id !== 'string' || !body.product_id) {
        return errorResponse('bad_request', 'product_id is required', 400, reqId);
      }

      try {
        const hashedKey = await hashLicenseKey(body.key as string, config.encryptionSecret);
        const result = await convex.mutation(api.manualLicenses.create, {
          apiSecret: config.convexApiSecret,
          authUserId: auth.authUserId,
          hashedKey,
          productId: body.product_id as string,
          maxUses: typeof body.max_uses === 'number' ? body.max_uses : undefined,
          expiresAt: typeof body.expires_at === 'number' ? body.expires_at : undefined,
          notes: typeof body.notes === 'string' ? body.notes : undefined,
          buyerEmail: typeof body.buyer_email === 'string' ? body.buyer_email : undefined,
        });
        return jsonResponse(result, 201, reqId);
      } catch (err) {
        logger.error('manualLicenses.create failed', { error: String(err) });
        return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
      }
    }

    return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
  }

  // GET /manual-licenses/:id
  const idMatch = subPath.match(/^\/manual-licenses\/([^/]+)$/);
  if (idMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['licenses:manage'], reqId);
    if (auth instanceof Response) return auth;

    const licenseId = idMatch[1];
    try {
      const result = await convex.query(api.manualLicenses.getById, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        licenseId,
      });
      if (!result) {
        return errorResponse(
          'not_found',
          `Manual license with ID ${licenseId} was not found`,
          404,
          reqId
        );
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('manualLicenses.getById failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
