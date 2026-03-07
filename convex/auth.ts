/**
 * Better Auth configuration for YUCP Creator Assistant
 * Runs on Convex with Discord OAuth and cross-domain support.
 *
 * The cross-domain plugin is required because the Bun API server (localhost:3001)
 * is on a different domain than Convex (.convex.site). It handles:
 * - Custom cookie headers (Set-Better-Auth-Cookie / Better-Auth-Cookie)
 * - One-time-token (OTT) pattern for OAuth callbacks
 * - State verification via database instead of cookies
 */

import { createClient } from '@convex-dev/better-auth';
import { convex, crossDomain } from '@convex-dev/better-auth/plugins';
import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import type { GenericCtx } from '@convex-dev/better-auth';
import { components } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import authConfig from './auth.config';

const siteUrl = process.env.SITE_URL ?? 'http://localhost:3001';

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

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

  const trustedOrigins = Array.from(
    new Set(
      [
        siteUrl,
        process.env.FRONTEND_URL,
        process.env.BETTER_AUTH_URL,
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:5173',
      ]
        .map(normalizeOrigin)
        .filter((origin): origin is string => Boolean(origin))
    )
  );

  console.log('Better Auth config', {
    siteUrl,
    betterAuthUrl: process.env.BETTER_AUTH_URL ?? null,
    frontendUrl: process.env.FRONTEND_URL ?? null,
    trustedOrigins,
  });

  return betterAuth({
    secret: process.env.BETTER_AUTH_SECRET!,
    trustedOrigins,
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
    },
    plugins: [
      // Required for client-side frameworks / cross-domain setups.
      // The browser talks directly to the Convex .site URL, and the
      // crossDomain plugin bridges cookies and handles OAuth callbacks
      // via one-time-tokens.
      crossDomain({ siteUrl }),
      // Required for Convex compatibility (JWT, adapter, schema).
      convex({ authConfig }),
    ],
  } satisfies BetterAuthOptions);
};
