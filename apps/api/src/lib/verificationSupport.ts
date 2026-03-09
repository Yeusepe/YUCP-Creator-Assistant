import {
  type StructuredLogger,
  encodeVerificationSupportToken,
  getVerificationSupportErrorDetails,
} from '@yucp/shared';

export interface PublicApiSupportErrorInput {
  error: unknown;
  stage: string;
  tenantId?: string;
}

/** Creates an encrypted support code for Public API errors. Same format as verification flow. */
export async function createPublicApiSupportError(
  logger: StructuredLogger,
  input: PublicApiSupportErrorInput
): Promise<{ supportCode: string }> {
  const errorDetails = getVerificationSupportErrorDetails(input.error);
  const support = await encodeVerificationSupportToken({
    surface: 'public_api',
    stage: input.stage,
    tenantId: input.tenantId,
    ...errorDetails,
  });

  logger.warn('Public API error', {
    supportCode: support.supportCode,
    stage: input.stage,
    tenantId: input.tenantId,
    error: input.error instanceof Error ? input.error.message : String(input.error),
  });

  return { supportCode: support.supportCode };
}

interface ApiVerificationSupportInput {
  discordUserId?: string;
  error: unknown;
  guildId?: string;
  provider?: string;
  stage: string;
  tenantId?: string;
}

export async function createApiVerificationSupportError(
  logger: StructuredLogger,
  input: ApiVerificationSupportInput
): Promise<{ supportCode: string; supportCodeMode: 'encoded' | 'plain' }> {
  const errorDetails = getVerificationSupportErrorDetails(input.error);
  const support = await encodeVerificationSupportToken({
    surface: 'api',
    stage: input.stage,
    tenantId: input.tenantId,
    guildId: input.guildId,
    discordUserId: input.discordUserId,
    provider: input.provider,
    ...errorDetails,
  });

  logger.error('Verification API route failed', {
    supportCode: support.supportCode,
    supportCodeMode: support.mode,
    stage: input.stage,
    tenantId: input.tenantId,
    guildId: input.guildId,
    discordUserId: input.discordUserId,
    provider: input.provider,
    error: input.error instanceof Error ? input.error.message : String(input.error),
    stack: input.error instanceof Error ? input.error.stack : undefined,
  });

  return {
    supportCode: support.supportCode,
    supportCodeMode: support.mode,
  };
}
