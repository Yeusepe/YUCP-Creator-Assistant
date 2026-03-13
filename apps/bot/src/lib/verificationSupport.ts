import {
  encodeVerificationSupportToken,
  formatVerificationSupportMessage,
  getVerificationSupportErrorDetails,
  type StructuredLogger,
} from '@yucp/shared';

interface BotVerificationSupportInput {
  baseMessage: string;
  discordUserId: string;
  error: unknown;
  guildId?: string;
  hadActivePanel?: boolean;
  provider?: string;
  stage: string;
  authUserId?: string;
}

export async function buildBotVerificationErrorMessage(
  logger: StructuredLogger,
  input: BotVerificationSupportInput
): Promise<string> {
  const errorDetails = getVerificationSupportErrorDetails(input.error);
  const support = await encodeVerificationSupportToken({
    surface: 'bot',
    stage: input.stage,
    authUserId: input.authUserId,
    guildId: input.guildId,
    discordUserId: input.discordUserId,
    provider: input.provider,
    hadActivePanel: input.hadActivePanel,
    ...errorDetails,
  });

  logger.error('Verification UI flow failed', {
    supportCode: support.supportCode,
    supportCodeMode: support.mode,
    stage: input.stage,
    authUserId: input.authUserId,
    guildId: input.guildId,
    discordUserId: input.discordUserId,
    provider: input.provider,
    hadActivePanel: input.hadActivePanel,
    error: input.error instanceof Error ? input.error.message : String(input.error),
    stack: input.error instanceof Error ? input.error.stack : undefined,
  });

  return formatVerificationSupportMessage(input.baseMessage, support.supportCode);
}
