/**
 * Load test secrets for integration tests.
 *
 * Secrets are loaded from:
 * 1. Infisical (when INFISICAL_PROJECT_ID + INFISICAL_MACHINE_IDENTITY_ID + INFISICAL_MACHINE_IDENTITY_SECRET are set)
 * 2. Fallback: process.env (use `infisical run -- bun test` or set vars manually)
 *
 * Integration tests should skip when secrets are unavailable: it.skipIf(!secrets?.gumroad)
 *
 * Setup: See docs/INFISICAL_SETUP.md and .env.test.example
 */

export interface TestSecrets {
  gumroad?: {
    clientId: string;
    clientSecret: string;
    /** Optional: access token from OAuth for getPurchases integration tests */
    accessToken?: string;
  };
  discord?: {
    clientId: string;
    clientSecret: string;
  };
  jinxxy?: {
    apiKey: string;
    /** Optional: test license key for verifyLicense integration tests */
    testLicenseKey?: string;
    /** Optional: test email for verifyPurchase integration tests */
    testEmail?: string;
  };
  convex?: {
    deploymentUrl: string;
    /** API secret for Convex mutations (must match CONVEX_API_SECRET in deployment) */
    apiSecret?: string;
    /** Optional: test tenant ID for verification session integration tests */
    testTenantId?: string;
    /** Optional: test subject ID for completeVerificationSession integration tests */
    testSubjectId?: string;
  };
}

const ENV_KEYS = {
  gumroad: ['GUMROAD_CLIENT_ID', 'GUMROAD_CLIENT_SECRET'] as const,
  discord: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'] as const,
  jinxxy: ['JINXXY_API_KEY'] as const,
  convex: ['CONVEX_DEPLOYMENT_URL'] as const,
} as const;

function loadFromEnv(): TestSecrets {
  const secrets: TestSecrets = {};

  if (process.env.GUMROAD_CLIENT_ID && process.env.GUMROAD_CLIENT_SECRET) {
    secrets.gumroad = {
      clientId: process.env.GUMROAD_CLIENT_ID,
      clientSecret: process.env.GUMROAD_CLIENT_SECRET,
      accessToken: process.env.GUMROAD_ACCESS_TOKEN,
    };
  }

  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
    secrets.discord = {
      clientId: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
    };
  }

  if (process.env.JINXXY_API_KEY) {
    secrets.jinxxy = {
      apiKey: process.env.JINXXY_API_KEY,
      testLicenseKey: process.env.JINXXY_TEST_LICENSE_KEY,
      testEmail: process.env.JINXXY_TEST_EMAIL,
    };
  }

  if (process.env.CONVEX_DEPLOYMENT_URL) {
    secrets.convex = {
      deploymentUrl: process.env.CONVEX_DEPLOYMENT_URL,
      apiSecret: process.env.CONVEX_API_SECRET,
      testTenantId: process.env.CONVEX_TEST_TENANT_ID,
      testSubjectId: process.env.CONVEX_TEST_SUBJECT_ID,
    };
  }

  return secrets;
}

function secretsFromInfisicalList(secrets: Array<{ secretKey: string; secretValue: string }>): TestSecrets {
  const map = new Map(secrets.map((s) => [s.secretKey, s.secretValue]));
  const result: TestSecrets = {};

  const gId = map.get('GUMROAD_CLIENT_ID');
  const gSecret = map.get('GUMROAD_CLIENT_SECRET');
  if (gId && gSecret)
    result.gumroad = {
      clientId: gId,
      clientSecret: gSecret,
      accessToken: map.get('GUMROAD_ACCESS_TOKEN'),
    };

  const dId = map.get('DISCORD_CLIENT_ID');
  const dSecret = map.get('DISCORD_CLIENT_SECRET');
  if (dId && dSecret) result.discord = { clientId: dId, clientSecret: dSecret };

  const jKey = map.get('JINXXY_API_KEY');
  if (jKey)
    result.jinxxy = {
      apiKey: jKey,
      testLicenseKey: map.get('JINXXY_TEST_LICENSE_KEY'),
      testEmail: map.get('JINXXY_TEST_EMAIL'),
    };

  const cUrl = map.get('CONVEX_DEPLOYMENT_URL') ?? map.get('CONVEX_URL');
  if (cUrl)
    result.convex = {
      deploymentUrl: cUrl,
      apiSecret: map.get('CONVEX_API_SECRET'),
      testTenantId: map.get('CONVEX_TEST_TENANT_ID'),
      testSubjectId: map.get('CONVEX_TEST_SUBJECT_ID'),
    };

  return result;
}

let cachedSecrets: TestSecrets | null | undefined = undefined;

/**
 * Load test secrets from Infisical or process.env.
 * Returns null if Infisical is not configured and env vars are missing.
 * Cached after first successful load.
 */
export async function loadTestSecrets(): Promise<TestSecrets | null> {
  if (cachedSecrets !== undefined) return cachedSecrets;

  const projectId = process.env.INFISICAL_PROJECT_ID;
  const machineId = process.env.INFISICAL_MACHINE_IDENTITY_ID;
  const machineSecret = process.env.INFISICAL_MACHINE_IDENTITY_SECRET;

  if (projectId && machineId && machineSecret) {
    try {
      const { fetchInfisicalSecrets } = await import('../src/infisical/fetchSecrets');
      const raw = await fetchInfisicalSecrets();
      const flatSecrets = Object.entries(raw).map(([secretKey, secretValue]) => ({
        secretKey,
        secretValue,
      }));
      cachedSecrets = secretsFromInfisicalList(flatSecrets);
      return cachedSecrets;
    } catch (err) {
      console.warn('[loadTestSecrets] Infisical fetch failed, falling back to env:', err);
    }
  }

  cachedSecrets = loadFromEnv();
  return Object.keys(cachedSecrets).length > 0 ? cachedSecrets : null;
}
