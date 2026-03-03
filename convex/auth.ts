/**
 * Better Auth configuration for YUCP Creator Assistant
 * Runs on Convex with Discord OAuth, admin plugin, and Convex adapter.
 */

import { createClient } from '@convex-dev/better-auth';
import { convex } from '@convex-dev/better-auth/plugins';
// import { admin } from 'better-auth/plugins';
import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import type { GenericCtx } from '@convex-dev/better-auth';
import { components } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import authConfig from './auth.config';

const siteUrl = process.env.SITE_URL ?? 'http://localhost:3001';

export const authComponent = createClient<DataModel>(components.betterAuth);

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  const discordConfig =
    process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET
      ? {
        discord: {
          clientId: process.env.DISCORD_CLIENT_ID,
          clientSecret: process.env.DISCORD_CLIENT_SECRET,
        },
      }
      : {};

  return betterAuth({
    baseURL: siteUrl,
    secret: process.env.BETTER_AUTH_SECRET!,
    trustedOrigins: [
      siteUrl,
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:5173',
    ],
    database: authComponent.adapter(ctx),
    socialProviders: discordConfig,
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // 1 day
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },
    advanced: {
      cookiePrefix: 'yucp',
      defaultCookieAttributes: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
      },
      // Required for OAuth state verification when auth is proxied (Bun -> Convex).
      // Better Auth uses X-Forwarded-Host and X-Forwarded-Proto to derive the client URL.
      trustedProxyHeaders: true,
    },
    plugins: [convex({ authConfig })],
  } satisfies BetterAuthOptions);
};
