import type {
  ConnectionProviderDisplayPort,
  ConnectionRepositoryPort,
  DashboardConnectionProviderDisplay,
  DashboardUserAccount,
} from '../ports/connection';

export interface DashboardHomeInput {
  readonly viewerAuthUserId: string;
  readonly connectionStatusAuthUserId?: string;
}

export interface DashboardHomeResult {
  readonly providers: readonly DashboardConnectionProviderDisplay[];
  readonly userAccounts: readonly DashboardUserAccount[];
  readonly connectionStatusAuthUserId: string;
  readonly connectionStatusByProvider: Record<string, boolean>;
}

export interface ConnectionServiceOptions {
  readonly connections: ConnectionRepositoryPort;
  readonly providerDisplays: ConnectionProviderDisplayPort;
}

function buildConnectionStatusByProvider(
  userAccounts: readonly DashboardUserAccount[]
): Record<string, boolean> {
  const status: Record<string, boolean> = {};
  for (const connection of userAccounts) {
    if (connection.provider && connection.status !== 'disconnected') {
      status[connection.provider] = true;
    }
  }
  return status;
}

export class ConnectionService {
  constructor(private readonly options: ConnectionServiceOptions) {}

  async getConnectionStatus(authUserId: string): Promise<Record<string, boolean>> {
    return this.options.connections.getConnectionStatus(authUserId);
  }

  async getDashboardHome(input: DashboardHomeInput): Promise<DashboardHomeResult> {
    const userAccounts = await this.options.connections.listUserAccounts(input.viewerAuthUserId);
    const connectionStatusAuthUserId = input.connectionStatusAuthUserId ?? input.viewerAuthUserId;
    const connectionStatusByProvider =
      connectionStatusAuthUserId === input.viewerAuthUserId
        ? buildConnectionStatusByProvider(userAccounts)
        : await this.options.connections.getConnectionStatus(connectionStatusAuthUserId);

    return {
      providers: this.options.providerDisplays.listDashboardProviderDisplays(),
      userAccounts,
      connectionStatusAuthUserId,
      connectionStatusByProvider,
    };
  }
}
