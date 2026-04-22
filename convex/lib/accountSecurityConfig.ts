export const RECOVERY_PASSKEY_CONTEXT_TTL_MS = 15 * 60 * 1000;

export const BETTER_AUTH_BACKUP_CODE_OPTIONS = {
  amount: 10,
  length: 10,
  storeBackupCodes: 'encrypted' as const,
  allowPasswordless: true,
};

export const RECOVERY_EMAIL_OTP_TYPE = 'forget-password' as const;
