import { sha256Hex } from '@yucp/shared/crypto';
import { api } from '../../../../../convex/_generated/api';
import type { BuyerLinkPlugin } from '../types';
import { GUMROAD_SHARED_CALLBACK_PATH } from './oauth';

const GUMROAD_USER_URL = 'https://api.gumroad.com/v2/user';

interface GumroadUserResponse {
  success?: boolean;
  user?: {
    user_id?: string;
    name?: string;
    email?: string;
  };
  message?: string;
}

async function fetchGumroadIdentity(accessToken: string) {
  // Gumroad API docs: https://gumroad.com/api
  const response = await fetch(GUMROAD_USER_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = (await response.json()) as GumroadUserResponse;
  if (!response.ok || data.success === false) {
    throw new Error(data.message ?? 'Failed to fetch Gumroad user');
  }

  const providerUserId = data.user?.user_id;
  if (!providerUserId) {
    throw new Error('Could not determine Gumroad user ID');
  }

  return {
    providerUserId,
    username: data.user?.name,
    email: data.user?.email,
  };
}

export function createGumroadBuyerLinkPlugin(): BuyerLinkPlugin {
  return {
    oauth: {
      providerId: 'gumroad',
      mode: 'gumroad',
      authUrl: 'https://gumroad.com/oauth/authorize',
      tokenUrl: 'https://api.gumroad.com/oauth/token',
      scopes: ['view_profile', 'view_sales'],
      callbackPath: GUMROAD_SHARED_CALLBACK_PATH,
      callbackHandler: 'connect-plugin',
      clientIdKey: 'gumroadClientId',
      clientSecretKey: 'gumroadClientSecret',
    },

    async fetchIdentity(accessToken) {
      return fetchGumroadIdentity(accessToken);
    },

    async afterLink(input, ctx) {
      const email = input.identity.email?.trim().toLowerCase();
      if (!email) {
        return;
      }

      await ctx.convex.mutation(api.backgroundSync.scheduleBackfillThenSyncForGumroadBuyer, {
        apiSecret: ctx.apiSecret,
        authUserId: input.authUserId,
        subjectId: input.subjectId,
        providerUserId: input.identity.providerUserId,
        emailHash: await sha256Hex(email),
      });
    },
  };
}

export const buyerLink = createGumroadBuyerLinkPlugin();
