import { describe, expect, it } from 'bun:test';
import { requiredConvexDeploymentEnv } from './preflight';

describe('Convex deployment required-env preflight', () => {
  it('derives analyzer-time required env from the Convex module graph', () => {
    const requiredEnv = requiredConvexDeploymentEnv();

    expect(requiredEnv).toContain('BETTER_AUTH_SECRET');
    expect(requiredEnv).not.toContain('DISCORD_BOT_TOKEN');
  });
});
