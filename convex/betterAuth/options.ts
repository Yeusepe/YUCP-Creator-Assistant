import { oauthProvider } from '@better-auth/oauth-provider';
import { apiKey } from '@better-auth/api-key';
import type { BetterAuthOptions } from 'better-auth/minimal';
import { jwt } from 'better-auth/plugins';
import { createJwtJwksAdapter } from './jwtAdapter';

const PUBLIC_API_AUDIENCE = 'yucp-public-api';
const PUBLIC_API_KEY_PREFIX = 'ypsk_';
const PUBLIC_API_KEY_PERMISSION_NAMESPACE = 'publicApi';

export const createSchemaAuthOptions = (): BetterAuthOptions =>
  ({
    secret: process.env.BETTER_AUTH_SECRET ?? 'MISSING_BETTER_AUTH_SECRET_CONFIGURE_CONVEX_ENV',
    baseURL: 'https://example.com',
    database: {} as never,
    plugins: [
      apiKey({
        defaultPrefix: PUBLIC_API_KEY_PREFIX,
        enableMetadata: true,
        requireName: true,
        enableSessionForAPIKeys: false,
        permissions: {
          defaultPermissions: {
            [PUBLIC_API_KEY_PERMISSION_NAMESPACE]: ['verification:read', 'subjects:read'],
          },
        },
      }),
      jwt({
        adapter: createJwtJwksAdapter(),
        jwt: {
          issuer: 'https://example.convex.site/api/auth',
          audience: PUBLIC_API_AUDIENCE,
        },
        disableSettingJwtHeader: true,
      }),
      oauthProvider({
        loginPage: 'https://example.com/oauth/login',
        consentPage: 'https://example.com/oauth/consent',
        scopes: ['verification:read', 'cert:issue'],
        validAudiences: [PUBLIC_API_AUDIENCE],
        cachedTrustedClients: new Set<string>(),
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        grantTypes: ['authorization_code', 'refresh_token'],
        silenceWarnings: {
          oauthAuthServerConfig: true,
        },
      }),
    ],
  }) as BetterAuthOptions;
