const PROVIDER_SCOPED_SUBJECT_ID_PATTERN = /^[a-z][a-z0-9_-]*:/i;

export function isProviderScopedSubjectId(value: string) {
  return PROVIDER_SCOPED_SUBJECT_ID_PATTERN.test(value);
}

export function resolveRoleSyncDiscordUserId(subject: { primaryDiscordUserId?: string | null }) {
  const discordUserId = subject.primaryDiscordUserId?.trim();
  if (!discordUserId || isProviderScopedSubjectId(discordUserId)) {
    return undefined;
  }
  return discordUserId;
}
