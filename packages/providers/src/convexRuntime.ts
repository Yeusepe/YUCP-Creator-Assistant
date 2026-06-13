import type { StructuredLogger } from '@yucp/shared';
import type { ProviderContext, ProviderRuntimeClient } from './contracts';

export type ConvexRuntimeLogger = Pick<StructuredLogger, 'info' | 'warn' | 'error'>;

export interface ConvexCollaboratorConnection {
  id: string;
  provider: string;
  credentialEncrypted?: string;
  collaboratorDisplayName?: string;
}

export interface ConvexProductSecretKey {
  permalink: string;
  encryptedSecretKey: string;
}

export interface ConvexProviderRuntimePorts {
  readonly logger: ConvexRuntimeLogger;
  loadPrimaryCredential(
    authUserId: string,
    provider: string,
    ctx: ProviderContext<ProviderRuntimeClient>
  ): Promise<string | null>;
  loadCollaboratorConnections(
    ownerAuthUserId: string,
    ctx: ProviderContext<ProviderRuntimeClient>
  ): Promise<ConvexCollaboratorConnection[]>;
  loadProductSecretKeys(
    authUserId: string,
    provider: string,
    ctx: ProviderContext<ProviderRuntimeClient>
  ): Promise<ConvexProductSecretKey[]>;
  decryptStoredCredential(
    encryptedCredential: string,
    purpose: string,
    ctx: ProviderContext<ProviderRuntimeClient>
  ): Promise<string | null>;
}
