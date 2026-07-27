import { ConvexHttpClient } from 'convex/browser';

type BetterAuthComponentClient = ConvexHttpClient & {
  function<T>(name: string, componentPath: string, args: unknown): Promise<T>;
  setAdminAuth(token: string, actingAsIdentity?: unknown): void;
};

export interface LocalBetterAuthEnrollment {
  authUserId: string;
  sessionToken: string;
}

export interface LocalBetterAuthBootstrap {
  cleanup: () => Promise<void>;
  createEnrollment: (name: string) => Promise<LocalBetterAuthEnrollment>;
}

function getStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === 'string' && fieldValue.length > 0 ? fieldValue : undefined;
}

function eqWhere(field: string, value: string) {
  return [{ field, operator: 'eq' as const, value }];
}

export async function signBetterAuthSessionToken(token: string, secret: string): Promise<string> {
  const signingKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(token));
  return `${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
}

/**
 * Better Auth one-time token reference:
 * https://better-auth.com/docs/plugins/one-time-token
 */
export async function mintBetterAuthOneTimeEnrollmentCapability(input: {
  fetch?: typeof fetch;
  sessionToken: string;
  webUrl: string;
}): Promise<string> {
  const webOrigin = new URL(input.webUrl);
  if (
    !['http:', 'https:'].includes(webOrigin.protocol) ||
    webOrigin.username ||
    webOrigin.password ||
    webOrigin.pathname !== '/' ||
    webOrigin.search ||
    webOrigin.hash
  ) {
    throw new Error('The Better Auth web URL must be one HTTP origin');
  }
  if (
    input.sessionToken.length === 0 ||
    input.sessionToken.length > 16_384 ||
    input.sessionToken.includes('\0')
  ) {
    throw new Error('The Better Auth bootstrap session is invalid');
  }
  const request = input.fetch ?? fetch;
  const response = await request(`${webOrigin.origin}/api/auth/one-time-token/generate`, {
    headers: {
      accept: 'application/json',
      cookie: `yucp.session_token=${input.sessionToken}`,
      origin: webOrigin.origin,
    },
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error('Better Auth did not mint an enrollment capability');
  }
  const body = (await response.json()) as { token?: unknown };
  if (
    typeof body.token !== 'string' ||
    body.token.length === 0 ||
    body.token.length > 1024 ||
    body.token.includes('\0')
  ) {
    throw new Error('Better Auth returned an invalid enrollment capability');
  }
  return body.token;
}

export function createLocalBetterAuthBootstrap(input: {
  adminKey: string;
  backendUrl: string;
  betterAuthSecret: string;
}): LocalBetterAuthBootstrap {
  const client = new ConvexHttpClient(input.backendUrl, {
    skipConvexDeploymentUrlCheck: true,
  }) as BetterAuthComponentClient;
  client.setAdminAuth(input.adminKey);
  const seededUserIds = new Set<string>();
  const callComponent = async <T>(name: string, args: unknown): Promise<T> =>
    await client.function<T>(name, 'betterAuth', args);

  return {
    createEnrollment: async (name) => {
      const suffix = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
      const email = `package-lifecycle-${suffix}@example.invalid`;
      const now = Date.now();
      const created = await callComponent<unknown>('adapter:create', {
        input: {
          data: {
            createdAt: now,
            email,
            emailVerified: true,
            name,
            updatedAt: now,
          },
          model: 'user',
        },
        select: ['_id', 'id'],
      });
      const authUserId = getStringField(created, '_id') ?? getStringField(created, 'id');
      if (!authUserId) {
        throw new Error('Better Auth user creation returned no user identifier');
      }
      seededUserIds.add(authUserId);
      const token = crypto.randomUUID();
      await callComponent('adapter:create', {
        input: {
          data: {
            createdAt: now,
            expiresAt: now + 15 * 60 * 1000,
            token,
            updatedAt: now,
            userId: authUserId,
          },
          model: 'session',
        },
        select: ['token'],
      });
      return {
        authUserId,
        sessionToken: await signBetterAuthSessionToken(token, input.betterAuthSecret),
      };
    },
    cleanup: async () => {
      const failures: unknown[] = [];
      for (const authUserId of seededUserIds) {
        for (const [model, field] of [
          ['session', 'userId'],
          ['account', 'userId'],
          ['user', '_id'],
        ] as const) {
          try {
            await callComponent('adapter:deleteMany', {
              input: {
                model,
                where: eqWhere(field, authUserId),
              },
              paginationOpts: { cursor: null, numItems: 100 },
            });
          } catch (error) {
            failures.push(error);
          }
        }
      }
      seededUserIds.clear();
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Better Auth lifecycle bootstrap cleanup failed');
      }
    },
  };
}
