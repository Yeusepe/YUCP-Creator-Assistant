import { CredentialExpiredError } from '@yucp/providers/contracts';
import {
  fetchPatreonBuyerIdentity,
  PATREON_PURPOSES,
  type PatreonBuyerIdentityRecord,
  type PatreonBuyerMembershipRecord,
} from '@yucp/providers/patreon/module';
import { api, internal } from '../../../../../convex/_generated/api';
import { decrypt, encrypt } from '../../lib/encrypt';
import { resolveBuyerVerificationStoreContext } from '../../verification/buyerVerificationHelpers';
import type {
  BuyerLinkPlugin,
  BuyerVerificationContext,
  VerifyHostedBuyerLinkIntentInput,
  VerifyHostedBuyerLinkIntentResult,
} from '../types';
import { PATREON_SHARED_CALLBACK_PATH } from './oauth';

const PROVIDER_LINK_EXPIRED_MESSAGE =
  'The linked Patreon account must be reconnected before it can be used.';
const PATREON_MEMBERSHIP_NOT_FOUND_MESSAGE =
  'No active Patreon membership was found for this campaign. If you just joined or changed tiers, please try again in a moment.';
const MISSING_PRODUCT_REF_MESSAGE =
  'Verification method is missing the Patreon campaign reference required for linked account verification.';
const REQUIRED_PATREON_BUYER_SCOPES = ['identity', 'identity.memberships', 'campaigns'] as const;

interface PatreonBuyerLinkDeps {
  fetchBuyerIdentity?: typeof fetchPatreonBuyerIdentity;
  encryptCredential?: typeof encrypt;
  decryptCredential?: typeof decrypt;
}

function buildPatreonSourceReference(memberId: string, campaignId: string): string {
  return `patreon:member:${memberId}:campaign:${campaignId}`;
}

function normalizePatreonMembershipStatus(
  membership: PatreonBuyerMembershipRecord
): 'active' | 'past_due' | 'cancelled' {
  // Patreon member identity responses expose `patron_status` plus the
  // `currently_entitled_tiers` relationship that we collapse into YUCP's entitlement
  // states here.
  // https://docs.patreon.com/#get-api-oauth2-v2-identity
  if (membership.patronStatus === 'declined_patron') {
    return 'past_due';
  }
  if (membership.patronStatus === 'former_patron' || membership.entitledTierIds.length === 0) {
    return 'cancelled';
  }
  return 'active';
}

function parsePatreonDate(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
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

async function syncPatreonMembershipEntitlements(
  identity: PatreonBuyerIdentityRecord,
  subjectId: string,
  ctx: BuyerVerificationContext,
  options: {
    campaignIdFilter?: ReadonlySet<string>;
  } = {}
): Promise<void> {
  const connectionCache = new Map<
    string,
    {
      authUserId: string;
      productId: string;
      displayName?: string;
      providerConnectionId: string;
    } | null
  >();

  for (const membership of identity.memberships) {
    const campaignId = membership.campaignId?.trim();
    if (!campaignId) {
      continue;
    }
    if (options.campaignIdFilter && !options.campaignIdFilter.has(campaignId)) {
      continue;
    }

    let creatorContext = connectionCache.get(campaignId);
    if (creatorContext === undefined) {
      const product = await ctx.convex.query(api.yucpLicenses.lookupProductByProviderRef, {
        apiSecret: ctx.apiSecret,
        provider: 'patreon',
        providerProductRef: campaignId,
      });
      if (!product) {
        connectionCache.set(campaignId, null);
        continue;
      }

      const creatorConnections = await ctx.convex.query(
        api.providerConnections.listConnectionsForUser,
        {
          apiSecret: ctx.apiSecret,
          authUserId: product.authUserId,
        }
      );
      const patreonConnection = creatorConnections.find(
        (connection: { id: string; provider: string }) => connection.provider === 'patreon'
      );
      if (!patreonConnection) {
        connectionCache.set(campaignId, null);
        continue;
      }

      creatorContext = {
        authUserId: product.authUserId,
        productId: product.productId,
        displayName: product.displayName,
        providerConnectionId: patreonConnection.id,
      };
      connectionCache.set(campaignId, creatorContext);
    }

    if (!creatorContext) {
      continue;
    }

    // Patreon identity includes `currently_entitled_tiers`, which is the upstream source
    // for the tier ids we persist as variant refs and entitlement evidence.
    // https://docs.patreon.com/#get-api-oauth2-v2-identity
    const activeTierRefs = [
      ...new Set(membership.entitledTierIds.map((tierId) => tierId.trim())),
    ].filter(Boolean);
    const normalizedStatus = normalizePatreonMembershipStatus({
      ...membership,
      entitledTierIds: activeTierRefs,
    });
    const sourceReference = buildPatreonSourceReference(membership.id, campaignId);
    const membershipId = await ctx.convex.mutation(api.providerPlatform.upsertProviderMembership, {
      apiSecret: ctx.apiSecret,
      authUserId: creatorContext.authUserId,
      providerConnectionId: creatorContext.providerConnectionId,
      providerKey: 'patreon',
      externalMembershipId: membership.id,
      externalProductId: campaignId,
      externalVariantId: activeTierRefs[0],
      externalCustomerId: identity.providerUserId,
      customerEmail: identity.email,
      status: normalizedStatus,
      startedAt: parsePatreonDate(membership.pledgeRelationshipStart),
      metadata: {
        activeTierRefs,
        lastChargeDate: membership.lastChargeDate,
        lastChargeStatus: membership.lastChargeStatus,
        patronStatus: membership.patronStatus,
      },
    });

    await ctx.convex.mutation(api.providerPlatform.upsertEntitlementEvidence, {
      apiSecret: ctx.apiSecret,
      authUserId: creatorContext.authUserId,
      subjectId,
      providerKey: 'patreon',
      providerConnectionId: creatorContext.providerConnectionId,
      membershipId,
      sourceReference,
      evidenceType: 'patreon.membership',
      status: normalizedStatus === 'active' ? 'active' : 'revoked',
      productId: creatorContext.productId,
      observedAt: Date.now(),
      metadata: {
        activeTierRefs,
        campaignId,
        providerUserId: identity.providerUserId,
      },
    });

    if (normalizedStatus === 'active') {
      await ctx.convex.mutation(api.entitlements.grantEntitlement, {
        apiSecret: ctx.apiSecret,
        authUserId: creatorContext.authUserId,
        subjectId,
        productId: creatorContext.productId,
        evidence: {
          provider: 'patreon',
          sourceReference,
          purchasedAt: parsePatreonDate(membership.pledgeRelationshipStart),
          rawEvidence: {
            campaignId,
            entitledTierIds: activeTierRefs,
            lastChargeDate: membership.lastChargeDate,
            lastChargeStatus: membership.lastChargeStatus,
            membershipId: membership.id,
            patronStatus: membership.patronStatus,
          },
        },
      });
      continue;
    }

    await ctx.convex.mutation(api.entitlements.revokeEntitlementBySourceRef, {
      apiSecret: ctx.apiSecret,
      authUserId: creatorContext.authUserId,
      subjectId,
      sourceReference,
      reason: normalizedStatus === 'past_due' ? 'manual' : 'expiration',
    });
  }
}

export function createPatreonBuyerLinkPlugin(deps: PatreonBuyerLinkDeps = {}): BuyerLinkPlugin {
  const readBuyerIdentity = deps.fetchBuyerIdentity ?? fetchPatreonBuyerIdentity;
  const encryptCredential = deps.encryptCredential ?? encrypt;
  const decryptCredential = deps.decryptCredential ?? decrypt;

  return {
    oauth: {
      providerId: 'patreon',
      mode: 'patreon',
      authUrl: 'https://www.patreon.com/oauth2/authorize',
      tokenUrl: 'https://www.patreon.com/api/oauth2/token',
      responseType: 'code',
      usesPkce: true,
      scopes: REQUIRED_PATREON_BUYER_SCOPES,
      callbackPath: PATREON_SHARED_CALLBACK_PATH,
      callbackHandler: 'connect-plugin',
    },

    async fetchIdentity(accessToken) {
      const identity = await readBuyerIdentity(accessToken, {});
      return {
        providerUserId: identity.providerUserId,
        username: identity.username,
        email: identity.email,
        avatarUrl: identity.avatarUrl,
        profileUrl: identity.profileUrl,
      };
    },

    async storeCredential(input, ctx) {
      const encryptedAccessToken = await encryptCredential(
        input.accessToken,
        ctx.encryptionSecret,
        PATREON_PURPOSES.buyerCredential
      );
      const encryptedRefreshToken = input.refreshToken
        ? await encryptCredential(
            input.refreshToken,
            ctx.encryptionSecret,
            PATREON_PURPOSES.buyerRefreshToken
          )
        : undefined;

      await ctx.convex.mutation(api.identitySync.storeExternalAccountOAuthCredentials, {
        apiSecret: ctx.apiSecret,
        externalAccountId: input.externalAccountId,
        oauthAccessTokenEncrypted: encryptedAccessToken,
        oauthRefreshTokenEncrypted: encryptedRefreshToken,
        oauthTokenExpiresAt: input.expiresAt,
      });
    },

    async afterLink(input, ctx) {
      const identity = await readBuyerIdentity(input.accessToken, {});
      await syncPatreonMembershipEntitlements(identity, input.subjectId, ctx);
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
            errorMessage: 'Verification method does not support linked Patreon verification.',
          },
          ctx.convex.mutation
        );
      }

      if (!requirement.providerProductRef) {
        return await markIntentFailed(
          input,
          {
            success: false,
            errorCode: 'invalid_method',
            errorMessage: MISSING_PRODUCT_REF_MESSAGE,
          },
          ctx.convex.mutation
        );
      }

      let creatorAuthUserId = requirement.creatorAuthUserId;
      let productId = requirement.productId;
      if (!creatorAuthUserId || !productId) {
        const storeContext = await resolveBuyerVerificationStoreContext(
          {
            providerId: 'patreon',
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

      const buyerProviderLink = await ctx.convex.query(
        internal.subjects.getBuyerProviderLinkForSubject,
        {
          subjectId: subjectResult.subject._id,
          provider: 'patreon',
        }
      );
      if (!buyerProviderLink) {
        return await markIntentFailed(
          input,
          {
            success: false,
            errorCode: 'provider_link_missing',
            errorMessage: 'No linked Patreon account was found for this verification method.',
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

      const credentials = await ctx.convex.query(
        api.identitySync.getExternalAccountOAuthCredentials,
        {
          apiSecret: ctx.apiSecret,
          externalAccountId: buyerProviderLink.externalAccountId,
        }
      );
      if (!credentials?.oauthAccessTokenEncrypted) {
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

      try {
        const accessToken = await decryptCredential(
          credentials.oauthAccessTokenEncrypted,
          ctx.encryptionSecret,
          PATREON_PURPOSES.buyerCredential
        );
        const identity = await readBuyerIdentity(accessToken, {});
        await syncPatreonMembershipEntitlements(identity, subjectResult.subject._id, ctx, {
          campaignIdFilter: new Set([requirement.providerProductRef]),
        });

        const hasEntitlement = await ctx.convex.query(
          internal.yucpLicenses.checkSubjectEntitlement,
          {
            authUserId: creatorAuthUserId,
            subjectId: subjectResult.subject._id,
            productId,
          }
        );
        if (!hasEntitlement) {
          return await markIntentFailed(
            input,
            {
              success: false,
              errorCode: 'membership_not_found',
              errorMessage: PATREON_MEMBERSHIP_NOT_FOUND_MESSAGE,
            },
            ctx.convex.mutation
          );
        }

        await ctx.convex.mutation(internal.verificationIntents.markIntentVerified, {
          intentId: input.intentId,
          methodKey: input.methodKey,
        });
        return { success: true };
      } catch (error) {
        if (error instanceof CredentialExpiredError) {
          await ctx.convex.mutation(internal.subjects.markBuyerProviderLinkExpired, {
            linkId: buyerProviderLink.id,
          });
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
        throw error;
      }
    },
  };
}

export const buyerLink = createPatreonBuyerLinkPlugin();
