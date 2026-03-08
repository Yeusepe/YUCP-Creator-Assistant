export interface ProviderMeta {
  id: string;
  label: string;
  emojiKey: string;
  addProductDescription: string;
  supportsLicenseVerify: boolean;
  supportsWebhook: boolean;
  supportsOAuth: boolean;
  supportsCredentialLogin: boolean;
  supportsDisconnect: boolean;
}

export const PROVIDER_META: Record<string, ProviderMeta> = {
  gumroad: {
    id: 'gumroad',
    label: 'Gumroad',
    emojiKey: 'Gumorad',
    addProductDescription: 'Sold on gumroad.com',
    supportsLicenseVerify: true,
    supportsWebhook: true,
    supportsOAuth: true,
    supportsCredentialLogin: false,
    supportsDisconnect: true,
  },
  jinxxy: {
    id: 'jinxxy',
    label: 'Jinxxy',
    emojiKey: 'Jinxxy',
    addProductDescription: 'Sold on jinxxy.com',
    supportsLicenseVerify: true,
    supportsWebhook: true,
    supportsOAuth: false,
    supportsCredentialLogin: false,
    supportsDisconnect: true,
  },
  vrchat: {
    id: 'vrchat',
    label: 'VRChat',
    emojiKey: 'VRC',
    addProductDescription: 'Avatar from vrchat.com/...',
    supportsLicenseVerify: true,
    supportsWebhook: false,
    supportsOAuth: false,
    supportsCredentialLogin: true,
    supportsDisconnect: true,
  },
  discord: {
    id: 'discord',
    label: 'Discord',
    emojiKey: 'Discord',
    addProductDescription: 'Discord role from another server',
    supportsLicenseVerify: false,
    supportsWebhook: false,
    supportsOAuth: true,
    supportsCredentialLogin: false,
    supportsDisconnect: true,
  },
  manual: {
    id: 'manual',
    label: 'Manual License',
    emojiKey: 'PersonKey',
    addProductDescription: 'Manually issued license key',
    supportsLicenseVerify: false,
    supportsWebhook: false,
    supportsOAuth: false,
    supportsCredentialLogin: false,
    supportsDisconnect: false,
  },
};

export const LICENSE_PROVIDERS = Object.values(PROVIDER_META)
  .filter((m) => m.supportsLicenseVerify)
  .map((m) => m.id);

export function providerLabel(id: string): string {
  return PROVIDER_META[id]?.label ?? id;
}
