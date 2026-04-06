import { ProviderPlatformService } from '../services/providerPlatformService';
import type { ApplicationServices, CreateApplicationServicesOptions } from './types';

export function createApplicationServices(
  options: CreateApplicationServicesOptions
): ApplicationServices {
  return {
    providerPlatform: new ProviderPlatformService(options.providerPlatform),
  };
}
