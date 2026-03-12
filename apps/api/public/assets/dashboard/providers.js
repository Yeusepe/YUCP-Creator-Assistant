export const DASHBOARD_PROVIDER_REGISTRY = [
  {
    key: 'gumroad',
    label: 'Gumroad',
    iconUrl:
      'https://cdn.brandfetch.io/idMw8qr5lW/w/400/h/400/theme/dark/icon.png?c=1bxid64Mup7aczewSAYMX&t=1667593186460',
    iconBg: '#0f0f12',
    iconClassName: 'w-6 h-6 rounded object-cover',
    description: 'Import sales & buyers',
    quickStartDescription: 'Connect Gumroad',
    quickStartButtonBg: 'rgba(255,255,255,0.05)',
    quickStartButtonBorder: 'rgba(255,255,255,0.1)',
    serverTileLabel: 'Enable Gumroad for this Server',
    serverTileHint: 'Allow users to verify Gumroad purchases in this Discord server.',
    setupState: 'ready',
  },
  {
    key: 'jinxxy',
    label: 'Jinxxy',
    iconUrl:
      'https://cdn.brandfetch.io/id5SOeZxOy/w/400/h/400/theme/dark/icon.jpeg?c=1bxid64Mup7aczewSAYMX&t=1770481661483',
    iconBg: '#9146FF',
    iconClassName: 'w-6 h-6 rounded object-cover',
    description: 'Import sales & buyers',
    quickStartDescription: 'Connect Jinxxy',
    quickStartButtonBg: 'rgba(145,70,255,0.1)',
    quickStartButtonBorder: 'rgba(145,70,255,0.3)',
    serverTileLabel: 'Enable Jinxxy for this Server',
    serverTileHint: 'Allow users to verify Jinxxy purchases in this Discord server.',
    setupState: 'ready',
  },
  {
    key: 'lemonsqueezy',
    label: 'Lemon Squeezy',
    iconUrl: '__API_BASE__/Icons/LemonSqueezy.png',
    iconBg: '#f7b84b',
    iconClassName: 'w-6 h-6 object-contain',
    description: 'API tokens, webhooks & license keys',
    quickStartDescription: 'Connect Lemon Squeezy',
    quickStartButtonBg: 'rgba(247,184,75,0.12)',
    quickStartButtonBorder: 'rgba(247,184,75,0.32)',
    serverTileLabel: 'Enable Lemon Squeezy for this Server',
    serverTileHint: 'Allow users to verify Lemon Squeezy purchases and licenses in this Discord server.',
    setupState: 'ready',
  },
  {
    key: 'payhip',
    label: 'Payhip',
    iconUrl: '__API_BASE__/Icons/Payhip.png',
    iconBg: '#3b82f6',
    iconClassName: 'w-6 h-6 object-contain',
    description: 'Webhooks & per-product license keys',
    quickStartDescription: 'Connect Payhip',
    quickStartButtonBg: 'rgba(59,130,246,0.12)',
    quickStartButtonBorder: 'rgba(59,130,246,0.32)',
    serverTileLabel: 'Enable Payhip for this Server',
    serverTileHint: 'Allow users to verify Payhip purchases and license keys in this Discord server.',
    setupState: 'ready',
  },

];

export function getDashboardProvider(providerKey) {
  return DASHBOARD_PROVIDER_REGISTRY.find((provider) => provider.key === providerKey) ?? null;
}

export function getActiveSetupProviders() {
  return DASHBOARD_PROVIDER_REGISTRY.filter((provider) => provider.setupState !== 'hidden');
}
