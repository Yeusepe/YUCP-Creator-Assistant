import type { BuyerVerificationCapabilityDescriptor, ProviderRuntimeModule } from '../contracts';
import { getProviderDescriptor } from '../providerMetadata';

export const MANUAL_PURPOSES = {
  credential: 'manual-license',
} as const;

function describeManualLicenseCapability(): BuyerVerificationCapabilityDescriptor | null {
  const descriptor = getProviderDescriptor('manual');
  if (!descriptor?.buyerVerificationMethods.includes('license_key') || !descriptor.licenseKey) {
    return null;
  }

  return {
    methodKind: 'manual_license',
    completion: 'immediate',
    actionLabel: 'Verify license',
    defaultTitle: `${descriptor.label} license`,
    defaultDescription: `Enter the ${descriptor.label.toLowerCase()} key you received for this product.`,
    input: {
      kind: 'license_key',
      label: descriptor.licenseKey.inputLabel,
      placeholder: descriptor.licenseKey.placeholder,
      masked: true,
      submitLabel: 'Verify license',
    },
  };
}

export function createManualProviderModule(): ProviderRuntimeModule<never> {
  return {
    id: 'manual',
    purposes: MANUAL_PURPOSES,
    needsCredential: false,
    async getCredential() {
      return null;
    },
    async fetchProducts() {
      // Manual products live in the local catalog and have no provider-side listing endpoint.
      return [];
    },
    hostedVerification: {
      describeManualLicenseCapability,
    },
  };
}
