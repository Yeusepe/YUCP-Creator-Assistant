import type {
  DashboardOwnershipPort,
  DashboardPolicyPort,
  DashboardShellSelectionInput,
} from '../ports/dashboardShell';

export interface DashboardSelectedServer {
  readonly authUserId: string;
  readonly guildId: string;
  readonly policy: Record<string, unknown>;
}

export interface DashboardShellSelectionResult {
  readonly connectionStatusAuthUserId: string;
  readonly selectedServer?: DashboardSelectedServer;
}

export interface DashboardShellServiceOptions {
  readonly ownership: DashboardOwnershipPort;
  readonly policy: DashboardPolicyPort;
}

export class DashboardShellService {
  constructor(private readonly options: DashboardShellServiceOptions) {}

  async resolveSelection(
    input: DashboardShellSelectionInput
  ): Promise<DashboardShellSelectionResult> {
    const selectedGuild =
      input.requestedGuildId !== undefined
        ? input.guilds.find((guild) => guild.guildId === input.requestedGuildId)
        : undefined;
    const selectedTenantAuthUserId =
      input.requestedAuthUserId ?? selectedGuild?.authUserId ?? input.viewerAuthUserId;

    if (selectedTenantAuthUserId !== input.viewerAuthUserId) {
      const ownsSelectedTenant = await this.options.ownership.viewerOwnsTenant(
        input.viewerAuthUserId,
        selectedTenantAuthUserId
      );
      if (!ownsSelectedTenant) {
        return {
          connectionStatusAuthUserId: input.viewerAuthUserId,
        };
      }

      return {
        connectionStatusAuthUserId: selectedTenantAuthUserId,
        ...(input.requestedGuildId
          ? {
              selectedServer: {
                authUserId: selectedTenantAuthUserId,
                guildId: input.requestedGuildId,
                policy: await this.options.policy.getPolicy(selectedTenantAuthUserId),
              },
            }
          : {}),
      };
    }

    if (input.requestedGuildId && selectedTenantAuthUserId) {
      return {
        connectionStatusAuthUserId: selectedTenantAuthUserId,
        selectedServer: {
          authUserId: selectedTenantAuthUserId,
          guildId: input.requestedGuildId,
          policy: await this.options.policy.getPolicy(selectedTenantAuthUserId),
        },
      };
    }

    return {
      connectionStatusAuthUserId: selectedTenantAuthUserId,
    };
  }
}
