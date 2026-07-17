import type { DeliveryUrlSignature } from './deliverySigning';
import { signDeliveryUrl, verifyDeliveryUrl } from './deliverySigning';

const UPLOAD_CAPABILITY_BINDING = 'tus-artifact-upload-v1';

export const UPLOAD_CAPABILITY_HEADERS = {
  catalogProductId: 'x-yucp-upload-catalog-product-id',
  exp: 'x-yucp-upload-exp',
  packageId: 'x-yucp-upload-package-id',
  sig: 'x-yucp-upload-sig',
  version: 'x-yucp-upload-version',
  versionId: 'x-yucp-upload-version-id',
} as const;

export type UploadCapability = DeliveryUrlSignature & {
  catalogProductId?: string;
  packageId: string;
  version: string;
  versionId: string;
};

export async function signUploadCapability(input: {
  catalogProductId?: string;
  expiresAt: Date | number;
  key: string;
  packageId: string;
  version: string;
  versionId: string;
}): Promise<UploadCapability> {
  const binding = uploadCapabilityBinding(input);
  const signature = await signDeliveryUrl({
    binding,
    expiresAt: input.expiresAt,
    key: input.key,
    versionId: input.versionId,
  });
  return {
    ...signature,
    packageId: input.packageId,
    version: input.version,
    versionId: input.versionId,
    ...(input.catalogProductId ? { catalogProductId: input.catalogProductId } : {}),
  };
}

export async function verifyUploadCapability(
  capability: UploadCapability & { now?: Date | number },
  key: string
): Promise<boolean> {
  try {
    return verifyDeliveryUrl({
      binding: uploadCapabilityBinding(capability),
      exp: capability.exp,
      key,
      now: capability.now,
      sig: capability.sig,
      versionId: capability.versionId,
    });
  } catch {
    return false;
  }
}

function uploadCapabilityBinding(input: {
  catalogProductId?: string;
  packageId: string;
  version: string;
}): string {
  if (!input.packageId || !input.version || input.catalogProductId === '') {
    throw new Error('Upload capability catalog target must not contain empty values');
  }
  return JSON.stringify([
    UPLOAD_CAPABILITY_BINDING,
    input.packageId,
    input.version,
    input.catalogProductId ?? null,
  ]);
}
