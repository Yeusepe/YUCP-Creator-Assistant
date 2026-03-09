import {
  encodeVerificationSupportToken,
  getVerificationSupportErrorDetails,
  type StructuredLogger,
} from '@yucp/shared';

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
