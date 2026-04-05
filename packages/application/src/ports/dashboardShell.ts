import type { DashboardGuildRecord } from './guildDirectory';

export interface DashboardOwnershipPort {
  viewerOwnsTenant(viewerAuthUserId: string, tenantAuthUserId: string): Promise<boolean>;
}

export interface DashboardPolicyPort {
  getPolicy(authUserId: string): Promise<Record<string, unknown>>;
}

export interface DashboardShellSelectionInput {
  readonly viewerAuthUserId: string;
  readonly guilds: readonly DashboardGuildRecord[];
  readonly requestedAuthUserId?: string;
  readonly requestedGuildId?: string;
}
