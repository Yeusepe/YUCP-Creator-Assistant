import { api } from '../../../../convex/_generated/api';
import { BILLING_CAPABILITY_KEYS } from '../../../../convex/lib/billingCapabilities';
import {
  signUploadCapability,
  UPLOAD_CAPABILITY_HEADERS,
} from '../../../../ops/storage-core/uploadSigning';
import type { Auth } from '../auth';
import { createAuthUserActorBinding } from '../lib/apiActor';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { RequestBodyError, readJsonObjectBodyWithLimit } from '../lib/requestBody';

export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const AUTHORIZE_BODY_MAX_BYTES = 4096;

export interface CreatorUploadConfig {
  apiBaseUrl: string;
  frontendBaseUrl: string;
  convexApiSecret: string;
  convexUrl: string;
  ingestTusUrl?: string;
  uploadHmacKey?: string;
}

interface CreateCreatorUploadRoutesOptions {
  auth: Auth;
  config: CreatorUploadConfig;
}

function allowedOrigins(config: CreatorUploadConfig): Set<string> {
  return new Set([new URL(config.apiBaseUrl).origin, new URL(config.frontendBaseUrl).origin]);
}

function requiredString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function createCreatorUploadRoutes({ auth, config }: CreateCreatorUploadRoutesOptions) {
  async function authorizeUpload(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    const csrfBlock = rejectCrossSiteRequest(request, allowedOrigins(config));
    if (csrfBlock) {
      return csrfBlock;
    }

    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonObjectBodyWithLimit(request, AUTHORIZE_BODY_MAX_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const packageId = requiredString(body, 'packageId');
    const version = requiredString(body, 'version');
    const catalogProductId =
      body.catalogProductId === undefined ? undefined : requiredString(body, 'catalogProductId');
    if (!packageId || !version || (body.catalogProductId !== undefined && !catalogProductId)) {
      return Response.json(
        { error: 'packageId and version are required; catalogProductId must be non-empty' },
        { status: 400 }
      );
    }

    const actor = await createAuthUserActorBinding({
      authUserId: session.user.id,
      source: 'session',
    });
    const convex = getConvexClientFromUrl(config.convexUrl, actor);
    const registration = (await convex.query(api.packageRegistry.lookupRegistration, {
      apiSecret: config.convexApiSecret,
      actor,
      packageId,
    })) as { status: 'active' | 'archived'; yucpUserId: string } | null;
    if (
      !registration ||
      registration.yucpUserId !== session.user.id ||
      registration.status !== 'active'
    ) {
      return Response.json({ error: 'Active package ownership required' }, { status: 403 });
    }
    const billing = (await convex.query(api.certificateBilling.getAccountOverview, {
      apiSecret: config.convexApiSecret,
      authUserId: session.user.id,
    })) as {
      billing?: { capabilities?: Array<{ capabilityKey: string; status: string }> };
    };
    const canUpload = billing.billing?.capabilities?.some(
      (capability) =>
        capability.capabilityKey === BILLING_CAPABILITY_KEYS.vpmRepo &&
        (capability.status === 'active' || capability.status === 'grace')
    );
    if (!canUpload) {
      return Response.json({ error: 'VPM repository capability required' }, { status: 403 });
    }
    if (catalogProductId) {
      const product = (await convex.query(
        api.packageRegistry.getBuyerAccessContextByCatalogProductId,
        {
          apiSecret: config.convexApiSecret,
          actor,
          catalogProductId,
        }
      )) as { creatorAuthUserId: string } | null;
      if (!product || product.creatorAuthUserId !== session.user.id) {
        return Response.json({ error: 'Catalog product ownership required' }, { status: 403 });
      }
    }

    const uploadHmacKey = config.uploadHmacKey?.trim();
    const ingestTusUrl = config.ingestTusUrl?.trim();
    if (!uploadHmacKey || !ingestTusUrl) {
      return Response.json({ error: 'Creator uploads are not configured' }, { status: 503 });
    }

    const versionId = crypto.randomUUID();
    const capability = await signUploadCapability({
      catalogProductId: catalogProductId ?? undefined,
      versionId,
      key: uploadHmacKey,
      packageId,
      version,
      expiresAt: Date.now() + UPLOAD_TTL_MS,
    });
    const headers = {
      ...(capability.catalogProductId
        ? {
            [UPLOAD_CAPABILITY_HEADERS.catalogProductId]: encodeURIComponent(
              capability.catalogProductId
            ),
          }
        : {}),
      [UPLOAD_CAPABILITY_HEADERS.versionId]: capability.versionId,
      [UPLOAD_CAPABILITY_HEADERS.exp]: capability.exp,
      [UPLOAD_CAPABILITY_HEADERS.packageId]: encodeURIComponent(capability.packageId),
      [UPLOAD_CAPABILITY_HEADERS.sig]: capability.sig,
      [UPLOAD_CAPABILITY_HEADERS.version]: encodeURIComponent(capability.version),
    };

    return Response.json(
      {
        versionId,
        exp: capability.exp,
        sig: capability.sig,
        tusEndpoint: `${ingestTusUrl.replace(/\/+$/, '')}/files`,
        headers,
        ...(catalogProductId ? { catalogProductId } : {}),
      },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  return { authorizeUpload };
}
