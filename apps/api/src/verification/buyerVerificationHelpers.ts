import { getProviderDescriptor } from '@yucp/providers/providerMetadata';
import { internal } from '../../../../convex/_generated/api';
import type {
  BuyerVerificationCapabilityDescriptor,
  BuyerVerificationContext,
  BuyerVerificationResult,
  BuyerVerificationSubmission,
} from '../providers/types';

export async function resolveBuyerVerificationStoreContext(
  input: Pick<BuyerVerificationSubmission, 'packageId' | 'providerProductRef'> & {
    providerId: string;
  },
  ctx: BuyerVerificationContext
): Promise<
  | {
      ok: true;
      creatorAuthUserId: string;
      creatorProductId: string;
      displayName?: string;
    }
  | {
      ok: false;
      result: BuyerVerificationResult;
    }
> {
  const product = await ctx.convex.query(internal.yucpLicenses.getProductByProviderRef, {
    provider: input.providerId,
    providerProductRef: input.providerProductRef,
  });

  if (!product) {
    return {
      ok: false,
      result: {
        success: false,
        errorCode: 'product_not_linked',
        errorMessage:
          'This verification method is not linked to an active creator product. Ask the creator to reconnect the store product and try again.',
      },
    };
  }

  const packageRegistration = await ctx.convex.query(internal.packageRegistry.getRegistration, {
    packageId: input.packageId,
  });

  if (!packageRegistration) {
    return {
      ok: false,
      result: {
        success: false,
        errorCode: 'package_not_registered',
        errorMessage:
          'This package is not registered for buyer verification yet. Ask the creator to finish package setup and try again.',
      },
    };
  }

  if (packageRegistration.yucpUserId !== product.authUserId) {
    return {
      ok: false,
      result: {
        success: false,
        errorCode: 'creator_store_mismatch',
        errorMessage:
          'This verification method points at a different creator store than the package being redeemed.',
      },
    };
  }

  return {
    ok: true,
    creatorAuthUserId: product.authUserId,
    creatorProductId: product.productId,
    displayName: product.displayName,
  };
}

export function createManualLicenseCapability(
  providerId: string
): BuyerVerificationCapabilityDescriptor {
  const descriptor = getProviderDescriptor(providerId);
  const providerLabel = descriptor?.label ?? providerId;

  return {
    methodKind: 'manual_license',
    completion: 'immediate',
    actionLabel: 'Verify license',
    defaultTitle: `${providerLabel} license`,
    defaultDescription: `Enter the ${providerLabel} license key for this product.`,
    input: {
      kind: 'license_key',
      label: descriptor?.licenseKey?.inputLabel ?? 'License Key',
      placeholder: descriptor?.licenseKey?.placeholder,
      masked: true,
      submitLabel: 'Verify license',
    },
  };
}
