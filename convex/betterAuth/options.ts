import { oauthProvider } from '@better-auth/oauth-provider';
import { apiKey } from '@better-auth/api-key';
import { passkey } from '@better-auth/passkey';
import {
  DEFAULT_PUBLIC_API_KEY_SCOPES,
  PUBLIC_API_AUDIENCE,
  PUBLIC_API_KEY_PERMISSION_NAMESPACE,
  PUBLIC_API_KEY_PREFIX,
  PUBLIC_API_SCOPES,
} from '@yucp/shared';
import type { BetterAuthOptions } from 'better-auth/minimal';
import { emailOTP, jwt, twoFactor } from 'better-auth/plugins';
import { createJwtJwksAdapter } from './jwtAdapter';

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
            [PUBLIC_API_KEY_PERMISSION_NAMESPACE]: [...DEFAULT_PUBLIC_API_KEY_SCOPES],
          },
        },
      }),
      jwt({
        adapter: createJwtJwksAdapter(),
        jwks: {
          keyPairConfig: {
            alg: 'RS256',
          },
        },
        jwt: {
          issuer: 'https://example.convex.site/api/auth',
          audience: PUBLIC_API_AUDIENCE,
        },
        disableSettingJwtHeader: true,
      }),
      oauthProvider({
        loginPage: 'https://example.com/oauth/login',
        consentPage: 'https://example.com/oauth/consent',
        scopes: [...PUBLIC_API_SCOPES],
        validAudiences: [PUBLIC_API_AUDIENCE],
        cachedTrustedClients: new Set<string>(),
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        grantTypes: ['authorization_code', 'refresh_token'],
        silenceWarnings: {
          oauthAuthServerConfig: true,
        },
      }),
      emailOTP({
        sendVerificationOTP: async () => {},
      }),
      twoFactor({
        allowPasswordless: true,
      }),
      passkey(),
    ],
  }) as BetterAuthOptions;
