/**
 * Tests for light auth identity resolution.
 *
 * `isLightOwnedSubject` is the safety gate on automatic subject reassignment: it decides whether a
 * subject's current owner is the disposable placeholder minted for its own Discord id, and only
 * then may ownership be handed to the real account. A false positive would move somebody else's
 * purchases onto the wrong account, so the negative cases matter more than the positive one.
 */

import { describe, expect, it } from 'bun:test';
import {
  buildLightAuthEmail,
  buildLightAuthMarker,
  isLightOwnedSubject,
} from './lightAuthIdentity';

const DISCORD_USER_ID = '1019369804181811290';
const LIGHT_AUTH_USER_ID = 'k57ffqpxw4y5xn6vd6ka2syrd9883v8m';
const REAL_AUTH_USER_ID = 'k574yq4n7wpb7ybnw2psnyjjr58bnwak';

/**
 * Answers only the light-marker lookup, and only for the marker belonging to `discordUserId`.
 * Anything else resolves to no user, which is what the real adapter does.
 */
function lightMarkerCtx(input: { discordUserId: string; lightAuthUserId: string }) {
  return {
    runQuery: async (_reference: unknown, args: unknown) => {
      const where = (args as { where?: Array<{ field: string; value: string }> }).where ?? [];
      const marker = where.find((clause) => clause.field === 'userId')?.value;
      return marker === buildLightAuthMarker(input.discordUserId)
        ? { _id: input.lightAuthUserId }
        : null;
    },
  } as unknown as Parameters<typeof isLightOwnedSubject>[0];
}

describe('light auth identity', () => {
  it('derives a marker and email that cannot collide with a real Discord sign-in', () => {
    expect(buildLightAuthMarker(DISCORD_USER_ID)).toBe(`light-discord:${DISCORD_USER_ID}`);
    // .invalid is reserved by RFC 2606, so this address can never be a real verified Discord email
    // and can never be matched by Better Auth's email-based account linking.
    expect(buildLightAuthEmail(DISCORD_USER_ID)).toBe(
      `discord+${DISCORD_USER_ID}@buyers.yucp.invalid`
    );
  });

  it('recognises a subject owned by the placeholder minted for its own Discord id', async () => {
    const ctx = lightMarkerCtx({
      discordUserId: DISCORD_USER_ID,
      lightAuthUserId: LIGHT_AUTH_USER_ID,
    });

    await expect(
      isLightOwnedSubject(ctx, {
        authUserId: LIGHT_AUTH_USER_ID,
        primaryDiscordUserId: DISCORD_USER_ID,
      })
    ).resolves.toBe(true);
  });

  it('refuses to treat a real account as a placeholder', async () => {
    const ctx = lightMarkerCtx({
      discordUserId: DISCORD_USER_ID,
      lightAuthUserId: LIGHT_AUTH_USER_ID,
    });

    await expect(
      isLightOwnedSubject(ctx, {
        authUserId: REAL_AUTH_USER_ID,
        primaryDiscordUserId: DISCORD_USER_ID,
      })
    ).resolves.toBe(false);
  });

  it("refuses a placeholder minted for a different person's Discord id", async () => {
    // The marker exists, but for someone else — reassigning here would hand this subject to the
    // wrong buyer.
    const ctx = lightMarkerCtx({
      discordUserId: '999999999999999999',
      lightAuthUserId: LIGHT_AUTH_USER_ID,
    });

    await expect(
      isLightOwnedSubject(ctx, {
        authUserId: LIGHT_AUTH_USER_ID,
        primaryDiscordUserId: DISCORD_USER_ID,
      })
    ).resolves.toBe(false);
  });

  it('treats an unowned subject as not light-owned so the plain claim path handles it', async () => {
    const ctx = lightMarkerCtx({
      discordUserId: DISCORD_USER_ID,
      lightAuthUserId: LIGHT_AUTH_USER_ID,
    });

    await expect(isLightOwnedSubject(ctx, { primaryDiscordUserId: DISCORD_USER_ID })).resolves.toBe(
      false
    );
  });
});
