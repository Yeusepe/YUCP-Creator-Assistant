import type { ProviderPlatformPort } from '../ports/providerPlatform';
import type { ProviderPlatformService } from '../services/providerPlatformService';

export interface CreateApplicationServicesOptions {
  readonly providerPlatform: ProviderPlatformPort;
}

export interface ApplicationServices {
  readonly providerPlatform: ProviderPlatformService;
}
