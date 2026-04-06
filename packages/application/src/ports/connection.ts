export interface DashboardConnectionProviderDisplay {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly iconBg: string;
  readonly quickStartBg: string;
  readonly quickStartBorder: string;
  readonly serverTileHint: string;
  readonly connectPath: string;
  readonly connectParamStyle: 'camelCase' | 'snakeCase';
}

export interface DashboardUserAccount {
  readonly id: string;
  readonly provider: string;
  readonly label: string;
  readonly connectionType: string;
  readonly status: string;
  readonly webhookConfigured: boolean;
  readonly hasApiKey: boolean;
  readonly hasAccessToken: boolean;
  readonly authUserId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ConnectionRepositoryPort {
  listUserAccounts(authUserId: string): Promise<readonly DashboardUserAccount[]>;
  getConnectionStatus(authUserId: string): Promise<Record<string, boolean>>;
}

export interface ConnectionProviderDisplayPort {
  listDashboardProviderDisplays(): readonly DashboardConnectionProviderDisplay[];
}
