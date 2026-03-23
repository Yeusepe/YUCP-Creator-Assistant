import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { primeDashboardShellCaches } from '../../src/lib/dashboardShellCache';
import type { DashboardShellData } from '../../src/lib/server/dashboard';

function createQueryClient() {
  return {
    setQueryData: vi.fn(),
  } as unknown as QueryClient & { setQueryData: ReturnType<typeof vi.fn> };
}

describe('dashboard shell cache priming', () => {
  it('hydrates shared home-panel queries from the route shell payload', () => {
    const queryClient = createQueryClient();
    const shell: DashboardShellData = {
      viewer: {
        authUserId: 'auth-user-1',
        name: 'Creator',
        email: 'creator@example.com',
        image: null,
        discordUserId: 'discord-user-1',
      },
      guilds: [
        {
          id: 'guild-1',
          name: 'Guild One',
          icon: null,
          tenantId: 'auth-user-1',
        },
      ],
      home: {
        providers: [{ key: 'gumroad', label: 'Gumroad', connectPath: '/setup/gumroad' }],
        userAccounts: [
          {
            id: 'conn-1',
            provider: 'gumroad',
            label: 'Gumroad Connection',
            connectionType: 'setup',
            status: 'active',
            webhookConfigured: true,
            hasApiKey: false,
            hasAccessToken: true,
            authUserId: 'auth-user-1',
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        connectionStatusAuthUserId: 'auth-user-1',
        connectionStatusByProvider: { gumroad: true },
      },
      selectedServer: {
        authUserId: 'auth-user-1',
        guildId: 'guild-1',
        policy: {
          autoVerifyOnJoin: true,
        },
      },
    };

    primeDashboardShellCaches(queryClient, shell);

    expect(queryClient.setQueryData).toHaveBeenCalledWith(['dashboard-shell'], {
      viewer: shell.viewer,
      guilds: shell.guilds,
      home: shell.home,
    });
    expect(queryClient.setQueryData).toHaveBeenCalledWith(
      ['dashboard-providers'],
      shell.home?.providers
    );
    expect(queryClient.setQueryData).toHaveBeenCalledWith(
      ['dashboard-user-accounts'],
      shell.home?.userAccounts
    );
    expect(queryClient.setQueryData).toHaveBeenCalledWith(
      ['dashboard-connection-status', 'auth-user-1'],
      shell.home?.connectionStatusByProvider
    );
    expect(queryClient.setQueryData).toHaveBeenCalledWith(
      ['dashboard-settings', 'auth-user-1'],
      shell.selectedServer?.policy
    );
  });
});
