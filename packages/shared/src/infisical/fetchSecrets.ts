/**
 * Shared Infisical SDK fetch - used by tests (loadTestSecrets) and apps (bot, api).
 * Supports both naming conventions:
 * - INFISICAL_MACHINE_IDENTITY_ID / INFISICAL_MACHINE_IDENTITY_SECRET
 * - INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET
 */

export async function fetchInfisicalSecrets(
  env: NodeJS.ProcessEnv = process.env
): Promise<Record<string, string>> {
  const projectId = env.INFISICAL_PROJECT_ID;
  const clientId = env.INFISICAL_CLIENT_ID ?? env.INFISICAL_MACHINE_IDENTITY_ID;
  const clientSecret = env.INFISICAL_CLIENT_SECRET ?? env.INFISICAL_MACHINE_IDENTITY_SECRET;
  const siteUrl = env.INFISICAL_URL ?? 'https://app.infisical.com';
  const envName = env.INFISICAL_ENV ?? 'dev';

  if (!projectId || !clientId || !clientSecret) {
    return {};
  }

  const { InfisicalSDK } = await import('@infisical/sdk');
  const client = new InfisicalSDK({ siteUrl });

  // Universal Auth login - authenticate with Infisical
  await client.auth().universalAuth.login({
    clientId,
    clientSecret,
  });

  const response = await client.secrets().listSecrets({
    projectId,
    environment: envName,
    recursive: true,
    viewSecretValue: true,
  });

  const secrets = response.secrets ?? [];
  return Object.fromEntries(
    secrets
      .filter((s): s is typeof s & { secretKey: string; secretValue: string } =>
        Boolean(s.secretKey && s.secretValue)
      )
      .map((s) => [s.secretKey, s.secretValue] as [string, string])
  );
}
