/**
 * Webhook processing cron - runs processPendingWebhookEvents with secret from env.
 * Isolated to avoid circular dependency with crons.ts.
 */

import { internalAction } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';

type WebhookCronResult = { processed: number; failed: number; errors: string[] };

export const processPendingWebhooksCron = internalAction({
  args: {},
  returns: v.object({
    processed: v.number(),
    failed: v.number(),
    errors: v.array(v.string()),
  }),
  handler: async (ctx): Promise<WebhookCronResult> => {
    const apiSecret = process.env.CONVEX_API_SECRET;
    if (!apiSecret) {
      throw new Error('CONVEX_API_SECRET not set for webhook processing cron');
    }
    const result = (await ctx.runAction(
      internal.webhookProcessing.processPendingWebhookEvents,
      { apiSecret, limit: 20 }
    )) as WebhookCronResult;
    return result;
  },
});
