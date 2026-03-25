export type ProtectedAssetUnlockMode = 'wrapped_content_key' | 'content_key_b64';

type ProtectedAssetUnlockRecord = {
  unlockMode?: ProtectedAssetUnlockMode;
  wrappedContentKey?: string;
  encryptedContentKey?: string;
};

export function resolveProtectedAssetUnlockMode(
  asset: ProtectedAssetUnlockRecord
): ProtectedAssetUnlockMode {
  if (asset.unlockMode) {
    return asset.unlockMode;
  }

  if (asset.encryptedContentKey && !asset.wrappedContentKey) {
    return 'content_key_b64';
  }

  return 'wrapped_content_key';
}
