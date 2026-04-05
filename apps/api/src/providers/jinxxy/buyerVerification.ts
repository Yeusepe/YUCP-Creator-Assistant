import { JinxxyApiClient } from '@yucp/providers';
import { api } from '../../../../../convex/_generated/api';
import {
  createManualLicenseCapability,
  resolveBuyerVerificationStoreContext,
} from '../../verification/buyerVerificationHelpers';
import { getJinxxyProviderRuntimeConfig } from '../runtimeConfig';
import type { BuyerVerificationAdapter } from '../types';
import { decryptJinxxyApiKey, resolveJinxxyCreatorApiKey } from './credentials';

async function verifyWithApiKey(
  apiKey: string,
  licenseKey: string,
  providerProductRef: string
): Promise<{ success: boolean; errorMessage?: string }> {
  const client = new JinxxyApiClient({
    apiKey,
    apiBaseUrl: getJinxxyProviderRuntimeConfig().apiBaseUrl,
  });

  const result = await client.verifyLicenseByKey(licenseKey);
  if (!result.valid) {
    return {
      success: false,
      errorMessage: result.error ?? 'License verification failed',
    };
  }

  if (
    providerProductRef &&
    result.license?.product_id &&
    result.license.product_id !== providerProductRef
  ) {
    return {
      success: false,
      errorMessage: 'License does not match the expected product',
    };
  }

  return { success: true };
}

export const buyerVerification: BuyerVerificationAdapter = {
  providerId: 'jinxxy',
  describeCapability(methodKind) {
    if (methodKind !== 'manual_license') {
      return null;
    }
    return createManualLicenseCapability('jinxxy');
  },
  async verify(input, ctx) {
    if (input.methodKind !== 'manual_license') {
      return {
        success: false,
        errorCode: 'unsupported_method',
        errorMessage: 'This verification method is not supported for Jinxxy.',
      };
    }

    const storeContext = await resolveBuyerVerificationStoreContext(
      {
        providerId: 'jinxxy',
        packageId: input.packageId,
        providerProductRef: input.providerProductRef,
      },
      ctx
    );
    if (!storeContext.ok) {
      return storeContext.result;
    }

    const apiKey = await resolveJinxxyCreatorApiKey(ctx, storeContext.creatorAuthUserId);
    if (apiKey) {
      const result = await verifyWithApiKey(apiKey, input.licenseKey, input.providerProductRef);
      if (result.success) {
        return { success: true };
      }
    }

    const collaboratorConnections = await ctx.convex.query(
      api.collaboratorInvites.getCollabConnectionsForVerification,
      {
        apiSecret: ctx.apiSecret,
        ownerAuthUserId: storeContext.creatorAuthUserId,
      }
    );

    for (const collaborator of collaboratorConnections) {
      if (collaborator.provider !== 'jinxxy' || !collaborator.credentialEncrypted) {
        continue;
      }

      const apiKey = await decryptJinxxyApiKey(
        collaborator.credentialEncrypted,
        ctx.encryptionSecret
      );
      const result = await verifyWithApiKey(apiKey, input.licenseKey, input.providerProductRef);
      if (result.success) {
        return { success: true };
      }
    }

    return {
      success: false,
      errorCode: 'invalid_proof',
      errorMessage: 'License verification failed',
    };
  },
};
