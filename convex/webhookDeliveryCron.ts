/**
 * Webhook delivery cron — triggers processWebhookDeliveries every minute.
 * Isolated to avoid circular dependency with crons.ts.
 */

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';

export const processWebhookDeliveriesCron = internalAction({
  args: {},
  returns: v.object({
    processed: v.number(),
    failed: v.number(),
    errors: v.array(v.string()),
  }),
  handler: async (ctx): Promise<{ processed: number; failed: number; errors: string[] }> => {
    const result: { processed: number; failed: number; errors: string[] } = await ctx.runAction(
      internal.webhookDeliveryWorker.processWebhookDeliveries,
      {}
    );
    return result;
  },
});
