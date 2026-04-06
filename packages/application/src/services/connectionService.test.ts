import { describe, expect, it } from 'bun:test';
import type {
  ConnectionProviderDisplayPort,
  ConnectionRepositoryPort,
  DashboardConnectionProviderDisplay,
  DashboardUserAccount,
} from '../ports/connection';
import { ConnectionService } from './connectionService';

const providerDisplays: readonly DashboardConnectionProviderDisplay[] = [
  {
    key: 'gumroad',
    label: 'Gumroad',
    icon: 'shopping-bag',
    iconBg: '#f97316',
    quickStartBg: '#fff7ed',
    quickStartBorder: '#fed7aa',
    serverTileHint: 'Storefront sales',
    connectPath: '/connect/gumroad',
    connectParamStyle: 'camelCase',
  },
];

const viewerAccounts: readonly DashboardUserAccount[] = [
  {
    id: 'conn-1',
    provider: 'gumroad',
    label: 'Main Gumroad',
    connectionType: 'oauth',
    status: 'active',
    webhookConfigured: true,
    hasApiKey: false,
    hasAccessToken: true,
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: 'conn-2',
    provider: 'jinxxy',
    label: 'Old Jinxxy',
    connectionType: 'api_key',
    status: 'disconnected',
    webhookConfigured: false,
    hasApiKey: false,
    hasAccessToken: false,
    createdAt: 3,
    updatedAt: 4,
  },
];

function createRepository(): ConnectionRepositoryPort & {
  readonly calls: {
    listUserAccounts: string[];
    getConnectionStatus: string[];
  };
} {
  const calls = {
    listUserAccounts: [] as string[],
    getConnectionStatus: [] as string[],
  };

  return {
    calls,
    async listUserAccounts(authUserId) {
      calls.listUserAccounts.push(authUserId);
      return viewerAccounts;
    },
    async getConnectionStatus(authUserId) {
      calls.getConnectionStatus.push(authUserId);
      return { vrchat: true };
    },
  };
}

function createProviderDisplays(): ConnectionProviderDisplayPort {
  return {
    listDashboardProviderDisplays() {
      return providerDisplays;
    },
  };
}

describe('ConnectionService', () => {
  it('builds dashboard home from viewer accounts without querying selected status twice', async () => {
    const repository = createRepository();
    const service = new ConnectionService({
      connections: repository,
      providerDisplays: createProviderDisplays(),
    });

    const result = await service.getDashboardHome({
      viewerAuthUserId: 'viewer-123',
    });

    expect(result).toEqual({
      providers: providerDisplays,
      userAccounts: viewerAccounts,
      connectionStatusAuthUserId: 'viewer-123',
      connectionStatusByProvider: {
        gumroad: true,
      },
    });
    expect(repository.calls.listUserAccounts).toEqual(['viewer-123']);
    expect(repository.calls.getConnectionStatus).toEqual([]);
  });

  it('loads selected tenant status when the dashboard is focused on another owned tenant', async () => {
    const repository = createRepository();
    const service = new ConnectionService({
      connections: repository,
      providerDisplays: createProviderDisplays(),
    });

    const result = await service.getDashboardHome({
      viewerAuthUserId: 'viewer-123',
      connectionStatusAuthUserId: 'tenant-456',
    });

    expect(result.connectionStatusAuthUserId).toBe('tenant-456');
    expect(result.connectionStatusByProvider).toEqual({ vrchat: true });
    expect(repository.calls.listUserAccounts).toEqual(['viewer-123']);
    expect(repository.calls.getConnectionStatus).toEqual(['tenant-456']);
  });

  it('proxies direct connection status lookups through the repository port', async () => {
    const repository = createRepository();
    const service = new ConnectionService({
      connections: repository,
      providerDisplays: createProviderDisplays(),
    });

    await expect(service.getConnectionStatus('tenant-789')).resolves.toEqual({
      vrchat: true,
    });
    expect(repository.calls.getConnectionStatus).toEqual(['tenant-789']);
  });
});
