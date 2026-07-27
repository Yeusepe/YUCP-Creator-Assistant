import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';

const reservationFields = {
  reservationId: v.string(),
  identifier: v.string(),
  value: v.string(),
  expiresAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
};

const CLEANUP_BATCH_SIZE = 256;

export const reserve = internalMutation({
  args: reservationFields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('better_auth_reservations')
      .withIndex('by_reservation_id', (query) => query.eq('reservationId', args.reservationId))
      .unique();

    if (existing && existing.expiresAt > Date.now()) {
      return false;
    }
    if (existing) {
      await ctx.db.delete(existing._id);
    }

    await ctx.db.insert('better_auth_reservations', args);
    return true;
  },
});

export const find = internalQuery({
  args: {
    reservationId: v.string(),
  },
  returns: v.union(v.null(), v.object(reservationFields)),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query('better_auth_reservations')
      .withIndex('by_reservation_id', (query) => query.eq('reservationId', args.reservationId))
      .unique();
    if (!record || record.expiresAt <= Date.now()) {
      return null;
    }

    return {
      reservationId: record.reservationId,
      identifier: record.identifier,
      value: record.value,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  },
});

export const cleanupExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const expired = await ctx.db
      .query('better_auth_reservations')
      .withIndex('by_expires_at', (query) => query.lte('expiresAt', Date.now()))
      .take(CLEANUP_BATCH_SIZE);
    for (const record of expired) {
      await ctx.db.delete(record._id);
    }
    return expired.length;
  },
});
