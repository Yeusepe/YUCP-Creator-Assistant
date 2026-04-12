// Shared types and utilities
// Re-export common types across the monorepo

import type { ProviderKey } from './providerKeys';

export interface EnvConfig {
  NODE_ENV: 'development' | 'production' | 'test';
  INFISICAL_URL?: string;
  INFISICAL_TOKEN?: string;
  LOG_LEVEL?: string;
}

export interface Tenant {
  id: string;
  name: string;
  createdAt: Date;
}

export interface User {
  id: string;
  discordId: string;
  email?: string;
  authUserId: string;
  role: 'admin' | 'creator' | 'buyer';
}

export type VerificationStatus = 'pending' | 'verified' | 'rejected' | 'expired';

export interface Verification {
  id: string;
  userId: string;
  provider: ProviderKey;
  status: VerificationStatus;
  expiresAt?: Date;
  createdAt: Date;
}

export * from './authOrigins';
export * from './authRedirects';
// Binding module exports
export * from './binding';
export * from './convexSiteUrl';
// Crypto module exports
export * from './crypto';
export { sha256Hex } from './crypto';
// Entitlement module exports
export * from './entitlement';
export * from './hyperdx';
export * from './internalRpcSecret';
export {
  createLogger,
  createStructuredLogger,
  type LogEntry,
  type LoggerConfig,
  type StructuredLogger,
  type StructuredLogger as Logger,
} from './logging';
export * from './logging/audit';
export * from './logging/correlation';
export * from './logging/redaction';
export * from './observability';
export * from './product';
export * from './productParsers';
export * from './publicAuthority';
export * from './verificationSupport';
