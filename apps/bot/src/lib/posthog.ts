/**
 * PostHog analytics client for Discord bot
 *
 * Tracks: command_used, verification_started, verification_completed,
 * verification_failed, spawn_button_clicked, product_added, suspicious_marked
 */

import { PostHog } from 'posthog-node';

let client: InstanceType<typeof PostHog> | null = null;

export function getPostHogClient(): InstanceType<typeof PostHog> | null {
  if (client) return client;
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) return null;
  client = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
  });
  return client;
}

export function track(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  const c = getPostHogClient();
  if (!c) return;
  c.capture({
    distinctId,
    event,
    properties: {
      ...properties,
      source: 'yucp-bot',
    },
  });
}

export function flush(): Promise<void> {
  const c = getPostHogClient();
  if (!c) return Promise.resolve();
  return c.flush();
}
