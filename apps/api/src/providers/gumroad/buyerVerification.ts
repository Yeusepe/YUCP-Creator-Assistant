import { GumroadAdapter } from '@yucp/providers';
import {
  createManualLicenseCapability,
  resolveBuyerVerificationStoreContext,
} from '../../verification/buyerVerificationHelpers';
import { getGumroadProviderRuntimeConfig } from '../runtimeConfig';
import type { BuyerVerificationAdapter } from '../types';

export const buyerVerification: BuyerVerificationAdapter = {
  providerId: 'gumroad',
  describeCapability(methodKind) {
    if (methodKind !== 'manual_license') {
      return null;
    }
    return createManualLicenseCapability('gumroad');
  },
  async verify(input, ctx) {
    if (input.methodKind !== 'manual_license') {
      return {
        success: false,
        errorCode: 'unsupported_method',
        errorMessage: 'This verification method is not supported for Gumroad.',
      };
    }

    const storeContext = await resolveBuyerVerificationStoreContext(
      {
        providerId: 'gumroad',
        packageId: input.packageId,
        providerProductRef: input.providerProductRef,
      },
      ctx
    );
    if (!storeContext.ok) {
      return storeContext.result;
    }

    // Gumroad license verify reference: https://gumroad.com/api#licenses
    const gumroadAdapter = new GumroadAdapter(getGumroadProviderRuntimeConfig());

    const result = await gumroadAdapter.verifyLicense(input.licenseKey, input.providerProductRef);
    if (!result.valid) {
      return {
        success: false,
        errorCode: 'invalid_proof',
        errorMessage: result.error ?? 'License verification failed',
      };
    }

    return { success: true };
  },
};
