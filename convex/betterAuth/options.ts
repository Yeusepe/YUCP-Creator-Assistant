import { oauthProvider } from '@better-auth/oauth-provider';
import type { BetterAuthOptions } from 'better-auth/minimal';
import { apiKey, jwt } from 'better-auth/plugins';

const PUBLIC_API_AUDIENCE = 'yucp-public-api';
const PUBLIC_API_KEY_PREFIX = 'ypsk_';
const PUBLIC_API_KEY_PERMISSION_NAMESPACE = 'publicApi';

export const createSchemaAuthOptions = (): BetterAuthOptions =>
  ({
    secret: 'schema-generation-secret-0123456789abcdef',
    baseURL: 'https://example.convex.site',
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
        jwt: {
          issuer: 'https://example.convex.site/api/auth',
          audience: PUBLIC_API_AUDIENCE,
        },
      }),
      oauthProvider({
        loginPage: 'http://localhost:3001/oauth/login',
        consentPage: 'http://localhost:3001/oauth/consent',
        scopes: ['verification:read'],
        validAudiences: [PUBLIC_API_AUDIENCE],
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        grantTypes: ['authorization_code', 'refresh_token'],
      }),
    ],
  }) as BetterAuthOptions;
