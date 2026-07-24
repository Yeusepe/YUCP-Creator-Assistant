import {
  type ExpiringHmacSignature,
  signExpiringHmacCapability,
  verifyExpiringHmacCapability,
} from './expiringHmacCapability';
import type { ProtectionPolicyId } from './protectionPolicy';

const UPLOAD_CAPABILITY_BINDING = 'tus-artifact-upload-v2';

export const UPLOAD_CAPABILITY_HEADERS = {
  catalogProductId: 'x-yucp-upload-catalog-product-id',
  creatorId: 'x-yucp-upload-creator-id',
  exp: 'x-yucp-upload-exp',
  packageId: 'x-yucp-upload-package-id',
  protectionPolicyId: 'x-yucp-upload-protection-policy-id',
  sig: 'x-yucp-upload-sig',
  version: 'x-yucp-upload-version',
  versionId: 'x-yucp-upload-version-id',
} as const;

export type UploadCapability = ExpiringHmacSignature & {
  catalogProductId?: string;
  creatorId: string;
  packageId: string;
  protectionPolicyId: ProtectionPolicyId;
  version: string;
  versionId: string;
};

export async function signUploadCapability(input: {
  catalogProductId?: string;
  creatorId: string;
  expiresAt: Date | number;
  key: string;
  packageId: string;
  protectionPolicyId: ProtectionPolicyId;
  version: string;
  versionId: string;
}): Promise<UploadCapability> {
  const binding = uploadCapabilityBinding(input);
  const signature = await signExpiringHmacCapability({
    binding: JSON.stringify([input.versionId, binding]),
    expiresAt: input.expiresAt,
    key: input.key,
    purpose: UPLOAD_CAPABILITY_BINDING,
  });
  return {
    ...signature,
    creatorId: input.creatorId,
    packageId: input.packageId,
    protectionPolicyId: input.protectionPolicyId,
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
    return verifyExpiringHmacCapability({
      binding: JSON.stringify([capability.versionId, uploadCapabilityBinding(capability)]),
      exp: capability.exp,
      key,
      now: capability.now,
      purpose: UPLOAD_CAPABILITY_BINDING,
      sig: capability.sig,
    });
  } catch {
    return false;
  }
}

function uploadCapabilityBinding(input: {
  catalogProductId?: string;
  creatorId: string;
  packageId: string;
  protectionPolicyId: ProtectionPolicyId;
  version: string;
}): string {
  if (
    !input.creatorId ||
    !input.packageId ||
    !input.protectionPolicyId ||
    !input.version ||
    input.catalogProductId === ''
  ) {
    throw new Error('Upload capability catalog target must not contain empty values');
  }
  return JSON.stringify([
    UPLOAD_CAPABILITY_BINDING,
    input.creatorId,
    input.packageId,
    input.version,
    input.catalogProductId ?? null,
    input.protectionPolicyId,
  ]);
}
