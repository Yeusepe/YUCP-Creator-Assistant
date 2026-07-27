import {
  type ExpiringHmacSignature,
  signExpiringHmacCapability,
  verifyExpiringHmacCapability,
} from './expiringHmacCapability';
import type { ProtectionPolicyId } from './protectionPolicyId';

const UPLOAD_CAPABILITY_BINDING = 'tus-artifact-upload-v2';

export const UPLOAD_CAPABILITY_HEADERS = {
  catalogProductId: 'x-yucp-upload-catalog-product-id',
  creatorId: 'x-yucp-upload-creator-id',
  editionId: 'x-yucp-upload-edition-id',
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
  editionId: string;
  packageId: string;
  protectionPolicyId: ProtectionPolicyId;
  version: string;
  versionId: string;
};

type UploadCapabilityVerificationInput = Omit<UploadCapability, 'protectionPolicyId'> & {
  now?: Date | number;
  protectionPolicyId: string;
};

export async function signUploadCapability(input: {
  catalogProductId?: string;
  creatorId: string;
  editionId?: string;
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
    editionId: input.editionId?.trim() || 'standard',
    packageId: input.packageId,
    protectionPolicyId: input.protectionPolicyId,
    version: input.version,
    versionId: input.versionId,
    ...(input.catalogProductId ? { catalogProductId: input.catalogProductId } : {}),
  };
}

export async function verifyUploadCapability(
  capability: UploadCapabilityVerificationInput,
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
  editionId?: string;
  packageId: string;
  protectionPolicyId: string;
  version: string;
}): string {
  const editionId = input.editionId?.trim() || 'standard';
  if (
    !input.creatorId ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(editionId) ||
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
    editionId,
    input.packageId,
    input.version,
    input.catalogProductId ?? null,
    input.protectionPolicyId,
  ]);
}
