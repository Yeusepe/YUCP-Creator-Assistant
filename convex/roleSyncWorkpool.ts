/**
 * Role Sync Workpool
 *
 * Durable, retrying execution of Discord `role_sync` / `role_removal` jobs.
 * Replaces the bot's 5s polling loop over `outbox_jobs`, which silently
 * disabled backoff and stranded `in_progress` jobs on every bot restart.
 *
 * Producers enqueue work transactionally from within the mutation that grants
 * or revokes the entitlement (see convex/lib/roleSyncEnqueue.ts). The pool runs
 * convex/roleSyncActions.ts and reports back via convex/roleSyncOnComplete.ts.
 */

import { Workpool } from '@convex-dev/workpool';
import { components } from './_generated/api';

export const roleSyncPool = new Workpool(components.roleSyncPool, {
  // Global concurrency cap. Discord rate limits are per-route (per guild member),
  // and the action additionally honors `429 Retry-After`, so a modest global cap
  // is enough to avoid hammering any single bucket.
  maxParallelism: 5,
  retryActionsByDefault: true,
  defaultRetryBehavior: {
    // ~1s, 2s, 4s, ... 512s with jitter => ~17 min of spaced retries. This is
    // what restores real backoff (the old poller burned 5 retries in ~22s).
    // For "member not yet in guild" the long-term backstop is guildMemberAdd,
    // which enqueues a fresh job when the user actually joins.
    maxAttempts: 10,
    initialBackoffMs: 1000,
    base: 2,
  },
});
