import { describe, expect, it } from 'bun:test';
import type { DashboardOwnershipPort, DashboardPolicyPort } from '../ports/dashboardShell';
import type { DashboardGuildRecord } from '../ports/guildDirectory';
import { DashboardShellService } from './dashboardShellService';

function createOwnership(
  ownedTenants: readonly string[]
): DashboardOwnershipPort & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    async viewerOwnsTenant(_viewerAuthUserId, tenantAuthUserId) {
      calls.push(tenantAuthUserId);
      return ownedTenants.includes(tenantAuthUserId);
    },
  };
}

function createPolicy(): DashboardPolicyPort & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    async getPolicy(authUserId) {
      calls.push(authUserId);
      return { policyOwner: authUserId };
    },
  };
}

const guilds: readonly DashboardGuildRecord[] = [
  {
    authUserId: 'viewer-123',
    guildId: 'guild-1',
    name: 'Viewer Guild',
    icon: null,
  },
  {
    authUserId: 'tenant-456',
    guildId: 'guild-2',
    name: 'Tenant Guild',
    icon: null,
  },
];

describe('DashboardShellService', () => {
  it('uses the viewer tenant by default and loads selected-server policy for the requested guild', async () => {
    const ownership = createOwnership([]);
    const policy = createPolicy();
    const service = new DashboardShellService({ ownership, policy });

    const result = await service.resolveSelection({
      viewerAuthUserId: 'viewer-123',
      guilds,
      requestedGuildId: 'guild-1',
    });

    expect(result).toEqual({
      connectionStatusAuthUserId: 'viewer-123',
      selectedServer: {
        authUserId: 'viewer-123',
        guildId: 'guild-1',
        policy: { policyOwner: 'viewer-123' },
      },
    });
    expect(ownership.calls).toEqual([]);
    expect(policy.calls).toEqual(['viewer-123']);
  });

  it('switches connection-status scope to an owned selected tenant', async () => {
    const ownership = createOwnership(['tenant-456']);
    const policy = createPolicy();
    const service = new DashboardShellService({ ownership, policy });

    const result = await service.resolveSelection({
      viewerAuthUserId: 'viewer-123',
      guilds,
      requestedAuthUserId: 'tenant-456',
    });

    expect(result).toEqual({
      connectionStatusAuthUserId: 'tenant-456',
    });
    expect(ownership.calls).toEqual(['tenant-456']);
    expect(policy.calls).toEqual([]);
  });

  it('loads selected-server policy for an owned tenant guild', async () => {
    const ownership = createOwnership(['tenant-456']);
    const policy = createPolicy();
    const service = new DashboardShellService({ ownership, policy });

    const result = await service.resolveSelection({
      viewerAuthUserId: 'viewer-123',
      guilds,
      requestedGuildId: 'guild-2',
    });

    expect(result).toEqual({
      connectionStatusAuthUserId: 'tenant-456',
      selectedServer: {
        authUserId: 'tenant-456',
        guildId: 'guild-2',
        policy: { policyOwner: 'tenant-456' },
      },
    });
    expect(ownership.calls).toEqual(['tenant-456']);
    expect(policy.calls).toEqual(['tenant-456']);
  });

  it('falls back to viewer scope when the selected tenant is not owned by the viewer', async () => {
    const ownership = createOwnership([]);
    const policy = createPolicy();
    const service = new DashboardShellService({ ownership, policy });

    const result = await service.resolveSelection({
      viewerAuthUserId: 'viewer-123',
      guilds,
      requestedAuthUserId: 'tenant-456',
      requestedGuildId: 'guild-2',
    });

    expect(result).toEqual({
      connectionStatusAuthUserId: 'viewer-123',
    });
    expect(ownership.calls).toEqual(['tenant-456']);
    expect(policy.calls).toEqual([]);
  });
});
