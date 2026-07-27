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

// Purge expired admin notifications every minute
crons.interval(
  'cleanup expired admin notifications',
  { minutes: 1 },
  internal.adminNotifications.cleanupExpired
);

crons.interval(
  'reconcile certificate billing state',
  { minutes: 15 },
  internal.certificateBillingSync.reconcileDueCustomers,
  {}
);

crons.interval(
  'cleanup Better Auth reservations',
  { minutes: 1 },
  internal.betterAuthReservations.cleanupExpired,
  {}
);

export default crons;
