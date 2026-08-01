/**
 * Light auth identity helpers.
 *
 * A "light" Better Auth user is a placeholder minted for a Discord-first buyer: someone who has
 * verified a purchase through the Discord bot but has never signed in to the website, so no real
 * Better Auth identity exists yet. The Discord-initiated account-link flow still has to write
 * bindings, provider links and subject ownership, and every one of those requires a non-null
 * authUserId — hence the placeholder.
 *
 * It is keyed deterministically on the Discord id (`light-discord:<id>`) so repeated Discord
 * verifications for the same person converge on one owner, and so a later real sign-in can be
 * proven to be the same human. A light user has no OAuth `account` row, so nobody can sign into it.
 *
 * These live in their own module because both `subjects.ts` (which materializes light users) and
 * `identitySync.ts` (which promotes them to real accounts) need them, and importing across those
 * two would be circular.
 */

import { components } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import {
  buildBetterAuthEqualityWhere,
  buildBetterAuthOAuthAccountLookupWhere,
} from './betterAuthAdapter';

export function buildLightAuthEmail(discordUserId: string) {
  return `discord+${discordUserId}@buyers.yucp.invalid`;
}

export function buildLightAuthMarker(discordUserId: string) {
  return `light-discord:${discordUserId}`;
}

export function buildLightAuthDisplayName(
  subject: Pick<Doc<'subjects'>, 'displayName' | 'primaryDiscordUserId'>
) {
  const trimmed = subject.displayName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : `Discord ${subject.primaryDiscordUserId}`;
}

export async function findBetterAuthUserIdByLightMarker(
  ctx: Pick<MutationCtx, 'runQuery'>,
  marker: string
): Promise<string | null> {
  const existingUser = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'user',
    where: buildBetterAuthEqualityWhere([{ field: 'userId', value: marker }]),
  })) as { id?: string; _id?: string } | null;

  return existingUser?.id ?? existingUser?._id ?? null;
}

export async function findBetterAuthUserIdsByDiscordUserId(
  ctx: Pick<MutationCtx, 'runQuery'>,
  discordUserId: string
): Promise<string[]> {
  const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: 'account',
    where: buildBetterAuthOAuthAccountLookupWhere('discord', discordUserId),
    select: ['userId'],
    paginationOpts: { cursor: null, numItems: 10 },
  })) as { page?: Array<{ userId?: string | null }> } | null;

  return Array.from(
    new Set(
      (result?.page ?? [])
        .map((record) => record.userId?.trim())
        .filter((userId): userId is string => Boolean(userId))
    )
  );
}

/**
 * Is this subject owned by the light placeholder minted for its own Discord id?
 *
 * Only that case is safe to reassign automatically: the marker *is* the Discord id, so the
 * placeholder and the real account are provably the same human. A subject owned by a different
 * real account is a genuine ambiguity and must not be reassigned.
 */
export async function isLightOwnedSubject(
  ctx: Pick<MutationCtx, 'runQuery'>,
  subject: { authUserId?: string; primaryDiscordUserId: string }
): Promise<boolean> {
  if (!subject.authUserId || !subject.primaryDiscordUserId) {
    return false;
  }
  const lightAuthUserId = await findBetterAuthUserIdByLightMarker(
    ctx,
    buildLightAuthMarker(subject.primaryDiscordUserId)
  );
  return lightAuthUserId !== null && lightAuthUserId === subject.authUserId;
}
