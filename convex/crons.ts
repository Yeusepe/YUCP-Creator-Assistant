/**
 * Convex Cron Jobs
 *
 * Scheduled functions for webhook processing and other recurring tasks.
 */

import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Process pending webhook events every minute
crons.interval(
  'process pending webhooks',
  { minutes: 1 },
  internal.webhookCron.processPendingWebhooksCron
);

// Process pending outbound webhook deliveries every minute
crons.interval(
  'process pending webhook deliveries',
  { minutes: 1 },
  internal.webhookDeliveryCron.processWebhookDeliveriesCron
);

export default crons;
