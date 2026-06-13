import { sha256Hex } from '@yucp/shared/crypto';
import { api, internal } from '../../../../../convex/_generated/api';
import { resolveBuyerVerificationStoreContext } from '../../verification/buyerVerificationHelpers';
import type {
  BuyerLinkPlugin,
  VerifyHostedBuyerLinkIntentInput,
  VerifyHostedBuyerLinkIntentResult,
} from '../types';
import { GUMROAD_SHARED_CALLBACK_PATH } from './oauth';

const GUMROAD_USER_URL = 'https://api.gumroad.com/v2/user';
const PROVIDER_LINK_EXPIRED_MESSAGE =
  'The linked Gumroad account must be reconnected before it can be used.';
const PURCHASE_NOT_FOUND_MESSAGE =
  'No purchase was found for this Gumroad account. If you just bought, please try again in a moment.';

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

async function markIntentFailed(
  input: VerifyHostedBuyerLinkIntentInput,
  result: VerifyHostedBuyerLinkIntentResult,
  mutation: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>
): Promise<VerifyHostedBuyerLinkIntentResult> {
  await mutation(internal.verificationIntents.markIntentFailed, {
    intentId: input.intentId,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  });
  return result;
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

    async verifyHostedIntent(input, ctx) {
      const intent = await ctx.convex.query(api.verificationIntents.getIntentRecord, {
        apiSecret: ctx.apiSecret,
        authUserId: input.authUserId,
        intentId: input.intentId,
      });

      if (!intent) {
        return {
          success: false,
          errorCode: 'not_found',
          errorMessage: 'Verification intent not found',
        };
      }
      if (intent.status !== 'pending') {
        return {
          success: false,
          errorCode: 'invalid_state',
          errorMessage: `Verification intent is ${intent.status}`,
        };
      }
      if (intent.expiresAt <= Date.now()) {
        return {
          success: false,
          errorCode: 'expired',
          errorMessage: 'Verification intent has expired',
        };
      }

      const requirement = intent.requirements.find(
        (entry: { methodKey: string; kind: string }) =>
          entry.methodKey === input.methodKey && entry.kind === 'buyer_provider_link'
      );
      if (!requirement) {
        return await markIntentFailed(
          input,
          {
            success: false,
            errorCode: 'invalid_method',
            errorMessage: 'Verification method does not support linked Gumroad verification.',
          },
          ctx.convex.mutation
        );
      }

      const subjectResult = await ctx.convex.query(api.subjects.getSubjectByAuthId, {
        apiSecret: ctx.apiSecret,
        authUserId: input.authUserId,
      });
      if (!subjectResult.found || !subjectResult.subject) {
        return await markIntentFailed(
          input,
          {
            success: false,
            errorCode: 'subject_not_found',
            errorMessage: 'No linked buyer subject was found for this YUCP account.',
          },
          ctx.convex.mutation
        );
      }

      const buyerProviderLink = await ctx.convex.query(
        internal.subjects.getBuyerProviderLinkForSubject,
        {
          subjectId: subjectResult.subject._id,
          provider: 'gumroad',
        }
      );
      if (!buyerProviderLink) {
        return await markIntentFailed(
          input,
          {
            success: false,
            errorCode: 'provider_link_missing',
            errorMessage: 'No linked provider account was found for this verification method.',
          },
          ctx.convex.mutation
        );
      }
      if (buyerProviderLink.status !== 'active') {
        return await markIntentFailed(
          input,
          {
            success: false,
            errorCode: 'provider_link_expired',
            errorMessage: PROVIDER_LINK_EXPIRED_MESSAGE,
          },
          ctx.convex.mutation
        );
      }

      if (!requirement.providerProductRef) {
        await ctx.convex.mutation(internal.verificationIntents.markIntentVerified, {
          intentId: input.intentId,
          methodKey: input.methodKey,
        });
        return { success: true };
      }

      let creatorAuthUserId = requirement.creatorAuthUserId;
      let productId = requirement.productId;
      if (!creatorAuthUserId || !productId) {
        const storeContext = await resolveBuyerVerificationStoreContext(
          {
            providerId: 'gumroad',
            packageId: intent.packageId,
            providerProductRef: requirement.providerProductRef,
          },
          ctx
        );
        if (!storeContext.ok) {
          return await markIntentFailed(input, storeContext.result, ctx.convex.mutation);
        }
        creatorAuthUserId = storeContext.creatorAuthUserId;
        productId = storeContext.creatorProductId;
      }

      const hasExistingEntitlement = await ctx.convex.query(
        internal.yucpLicenses.checkSubjectEntitlement,
        {
          authUserId: creatorAuthUserId,
          subjectId: subjectResult.subject._id,
          productId,
        }
      );
      if (hasExistingEntitlement) {
        await ctx.convex.mutation(internal.verificationIntents.markIntentVerified, {
          intentId: input.intentId,
          methodKey: input.methodKey,
        });
        return { success: true };
      }

      const accountInfo = await ctx.convex.query(internal.subjects.getExternalAccountEmailHash, {
        externalAccountId: buyerProviderLink.externalAccountId,
      });

      await ctx.convex.action(internal.backgroundSync.syncPastPurchasesForSubject, {
        subjectId: subjectResult.subject._id,
        provider: 'gumroad',
        providerUserId: buyerProviderLink.providerUserId,
        emailHash: accountInfo?.emailHash,
      });

      const hasEntitlement = await ctx.convex.query(internal.yucpLicenses.checkSubjectEntitlement, {
        authUserId: creatorAuthUserId,
        subjectId: subjectResult.subject._id,
        productId,
      });
      if (!hasEntitlement) {
        return await markIntentFailed(
          input,
          {
            success: false,
            errorCode: 'purchase_not_found',
            errorMessage: PURCHASE_NOT_FOUND_MESSAGE,
          },
          ctx.convex.mutation
        );
      }

      await ctx.convex.mutation(internal.verificationIntents.markIntentVerified, {
        intentId: input.intentId,
        methodKey: input.methodKey,
      });
      return { success: true };
    },
  };
}

export const buyerLink = createGumroadBuyerLinkPlugin();
