import {
  createVerificationSupportContext,
  formatVerificationSupportMessage,
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
  const support = await createVerificationSupportContext({
    surface: 'bot',
    stage: input.stage,
    authUserId: input.authUserId,
    guildId: input.guildId,
    discordUserId: input.discordUserId,
    provider: input.provider,
    hadActivePanel: input.hadActivePanel,
    error: input.error,
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
    error: support.logErrorMessage,
    stack: support.logErrorStack,
  });

  return formatVerificationSupportMessage(input.baseMessage, support.supportCode);
}
