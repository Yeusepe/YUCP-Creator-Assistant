import type { ProviderContext, ProviderRuntimeClient } from '@yucp/providers/contracts';
import { symmetricDecrypt } from 'better-auth/crypto';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { AUTH_MODE_CREDENTIAL_KEY } from '../lib/credentialKeys';

type StoredProviderConnection = {
  credentials: Record<string, string>;
} | null;

export type StoredCollaboratorConnection = {
  id: string;
  provider: string;
  credentialEncrypted?: string;
  collaboratorDisplayName?: string;
};

export const providerRuntimeLogger = {
  info() {},
  warn() {},
  error() {},
} as const;

const unusedProviderRuntimeClient: ProviderRuntimeClient = {
  async query() {
    throw new Error('Provider runtime Convex client is not available in yucpLicenses verification');
  },
  async mutation() {
    throw new Error('Provider runtime Convex client is not available in yucpLicenses verification');
  },
};

function getCredentialEncryptionSecret(): string {
  const secret = process.env.ENCRYPTION_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error('ENCRYPTION_SECRET or BETTER_AUTH_SECRET must be configured');
  }
  return secret;
}

async function deriveCredentialKey(secret: string, purpose: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: encoder.encode(purpose),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

async function decryptHkdfCredential(
  ciphertextB64: string,
  secret: string,
  purpose: string
): Promise<string> {
  const key = await deriveCredentialKey(secret, purpose);
  const combined = Uint8Array.from(atob(ciphertextB64), (char) => char.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

export async function decryptStoredCredential(
  encryptedCredential: string,
  purpose: string
): Promise<string | null> {
  const secret = getCredentialEncryptionSecret();
  try {
    return await decryptHkdfCredential(encryptedCredential, secret, purpose);
  } catch {
    const legacySecret = process.env.BETTER_AUTH_SECRET?.trim();
    if (!legacySecret) {
      return null;
    }
    try {
      return await symmetricDecrypt({ key: legacySecret, data: encryptedCredential });
    } catch {
      return null;
    }
  }
}

async function loadProviderConnection(
  ctx: ActionCtx,
  authUserId: string,
  provider: string
): Promise<StoredProviderConnection> {
  return await ctx.runQuery(internal.yucpLicenses.getProviderConnection, {
    authUserId,
    provider,
  });
}

function selectPrimaryCredential(credentials: Record<string, string>): string | null {
  for (const credentialKey of Object.values(AUTH_MODE_CREDENTIAL_KEY)) {
    const encryptedCredential = credentials[credentialKey];
    if (encryptedCredential) {
      return encryptedCredential;
    }
  }
  return null;
}

export async function loadPrimaryCredential(
  ctx: ActionCtx,
  authUserId: string,
  provider: string
): Promise<string | null> {
  const connection = await loadProviderConnection(ctx, authUserId, provider);
  return connection ? selectPrimaryCredential(connection.credentials) : null;
}

export async function loadCollaboratorConnections(
  ctx: ActionCtx,
  ownerAuthUserId: string
): Promise<StoredCollaboratorConnection[]> {
  return await ctx.runQuery(internal.yucpLicenses.getCollaboratorConnections, {
    ownerAuthUserId,
  });
}

export async function loadPayhipProductSecretKeys(
  ctx: ActionCtx,
  authUserId: string
): Promise<Array<{ permalink: string; encryptedSecretKey: string }>> {
  const connection = await loadProviderConnection(ctx, authUserId, 'payhip');
  if (!connection) {
    return [];
  }
  return Object.entries(connection.credentials)
    .filter(
      ([credentialKey, encryptedSecretKey]) =>
        credentialKey.startsWith('product_key:') && encryptedSecretKey.length > 0
    )
    .map(([credentialKey, encryptedSecretKey]) => ({
      permalink: credentialKey.slice('product_key:'.length),
      encryptedSecretKey,
    }));
}

export function buildProviderContext(authUserId: string): ProviderContext<ProviderRuntimeClient> {
  return {
    convex: unusedProviderRuntimeClient,
    apiSecret: '',
    authUserId,
    encryptionSecret: getCredentialEncryptionSecret(),
  };
}
