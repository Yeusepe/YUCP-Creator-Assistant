import { LemonSqueezyApiClient } from '@yucp/providers';
import { LEMONSQUEEZY_PURPOSES } from '@yucp/providers/lemonsqueezy/module';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import {
  createManualLicenseCapability,
  resolveBuyerVerificationStoreContext,
} from '../../verification/buyerVerificationHelpers';
import type { BuyerVerificationAdapter } from '../types';

const CREDENTIAL_PURPOSE = LEMONSQUEEZY_PURPOSES.credential;

export const buyerVerification: BuyerVerificationAdapter = {
  providerId: 'lemonsqueezy',
  describeCapability(methodKind) {
    if (methodKind !== 'manual_license') {
      return null;
    }
    return createManualLicenseCapability('lemonsqueezy');
  },
  async verify(input, ctx) {
    if (input.methodKind !== 'manual_license') {
      return {
        success: false,
        errorCode: 'unsupported_method',
        errorMessage: 'This verification method is not supported for Lemon Squeezy.',
      };
    }

    const storeContext = await resolveBuyerVerificationStoreContext(
      {
        providerId: 'lemonsqueezy',
        packageId: input.packageId,
        providerProductRef: input.providerProductRef,
      },
      ctx
    );
    if (!storeContext.ok) {
      return storeContext.result;
    }

    const connection = await ctx.convex.query(api.providerConnections.getConnectionForBackfill, {
      apiSecret: ctx.apiSecret,
      authUserId: storeContext.creatorAuthUserId,
      provider: 'lemonsqueezy',
    });

    const encryptedApiToken = connection?.credentials.api_token;
    if (!encryptedApiToken) {
      return {
        success: false,
        errorCode: 'creator_store_unavailable',
        errorMessage:
          'The creator has not connected a Lemon Squeezy store for this product yet. Ask them to reconnect the store and try again.',
      };
    }

    const apiToken = await decrypt(encryptedApiToken, ctx.encryptionSecret, CREDENTIAL_PURPOSE);

    // Lemon Squeezy license API reference: https://docs.lemonsqueezy.com/api/license-api
    const client = new LemonSqueezyApiClient({ apiToken });
    const validation = await client.validateLicenseKey(input.licenseKey);
    const verifiedProductId = validation.meta?.product_id
      ? String(validation.meta.product_id)
      : undefined;

    if (!validation.valid) {
      return {
        success: false,
        errorCode: 'invalid_proof',
        errorMessage: validation.error ?? 'License verification failed',
      };
    }

    if (
      input.providerProductRef &&
      verifiedProductId &&
      verifiedProductId !== input.providerProductRef
    ) {
      return {
        success: false,
        errorCode: 'invalid_proof',
        errorMessage: 'License does not match the expected product',
      };
    }

    return { success: true };
  },
};
