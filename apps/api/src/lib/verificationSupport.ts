import { createVerificationSupportContext, type StructuredLogger } from '@yucp/shared';

export interface PublicApiSupportErrorInput {
  error: unknown;
  stage: string;
  authUserId?: string;
}

/**
 * Creates an encrypted support code for Public API errors.
 * Same format as verification flow.
 */
export async function createPublicApiSupportError(
  logger: StructuredLogger,
  input: PublicApiSupportErrorInput
): Promise<{ supportCode: string }> {
  const support = await createVerificationSupportContext({
    surface: 'public_api',
    stage: input.stage,
    authUserId: input.authUserId,
    error: input.error,
  });

  logger.warn('Public API error', {
    supportCode: support.supportCode,
    stage: input.stage,
    authUserId: input.authUserId,
    error: support.logErrorMessage,
  });

  return { supportCode: support.supportCode };
}

interface ApiVerificationSupportInput {
  discordUserId?: string;
  error: unknown;
  guildId?: string;
  provider?: string;
  stage: string;
  authUserId?: string;
}

export async function createApiVerificationSupportError(
  logger: StructuredLogger,
  input: ApiVerificationSupportInput
): Promise<{ supportCode: string; supportCodeMode: 'encoded' | 'plain' }> {
  const support = await createVerificationSupportContext({
    surface: 'api',
    stage: input.stage,
    authUserId: input.authUserId,
    guildId: input.guildId,
    discordUserId: input.discordUserId,
    provider: input.provider,
    error: input.error,
  });

  logger.error('Verification API route failed', {
    supportCode: support.supportCode,
    supportCodeMode: support.mode,
    stage: input.stage,
    authUserId: input.authUserId,
    guildId: input.guildId,
    discordUserId: input.discordUserId,
    provider: input.provider,
    error: support.logErrorMessage,
    stack: support.logErrorStack,
  });

  return {
    supportCode: support.supportCode,
    supportCodeMode: support.mode,
  };
}
