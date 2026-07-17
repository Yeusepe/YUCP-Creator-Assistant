import type { DeliveryUrlSignature } from './deliverySigning';
import { signDeliveryUrl, verifyDeliveryUrl } from './deliverySigning';

const UPLOAD_CAPABILITY_BINDING = 'tus-artifact-upload-v1';

export type UploadCapability = DeliveryUrlSignature & {
  versionId: string;
};

export async function signUploadCapability(input: {
  expiresAt: Date | number;
  key: string;
  versionId: string;
}): Promise<UploadCapability> {
  const signature = await signDeliveryUrl({
    binding: UPLOAD_CAPABILITY_BINDING,
    expiresAt: input.expiresAt,
    key: input.key,
    versionId: input.versionId,
  });
  return { ...signature, versionId: input.versionId };
}

export async function verifyUploadCapability(
  capability: UploadCapability & { now?: Date | number },
  key: string
): Promise<boolean> {
  return verifyDeliveryUrl({
    binding: UPLOAD_CAPABILITY_BINDING,
    exp: capability.exp,
    key,
    now: capability.now,
    sig: capability.sig,
    versionId: capability.versionId,
  });
}
