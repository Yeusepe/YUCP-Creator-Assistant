import { createLocalAccountIssuer, createOAuthAccountIssuer } from '@better-auth/core/db';

export type LegacyAccountIdentityInput = {
  accountId?: string;
  providerId: string;
  userId: string;
  password?: string | null;
};

export type BetterAuthV17AccountIdentity = {
  issuer: string;
  providerAccountId: string;
};

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function deriveBetterAuthV17AccountIdentity(
  input: LegacyAccountIdentityInput
): BetterAuthV17AccountIdentity | null {
  if (!hasText(input.accountId) || !hasText(input.providerId)) {
    return null;
  }

  const isCredentialAccount = input.providerId === 'credential' || hasText(input.password);
  return {
    issuer: isCredentialAccount
      ? createLocalAccountIssuer(input.providerId)
      : createOAuthAccountIssuer(input.providerId),
    providerAccountId: input.accountId,
  };
}
