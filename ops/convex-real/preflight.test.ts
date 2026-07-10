import { describe, expect, it } from 'bun:test';
import {
  assertRequiredConvexDeploymentEnv,
  deploymentEnvGetIsSet,
  requiredConvexDeploymentEnv,
  requiredConvexDeploymentEnvRequirements,
} from './preflight';

describe('Convex deployment required-env preflight', () => {
  it('derives analyzer-time required env from the Convex module graph', () => {
    const requiredEnv = requiredConvexDeploymentEnv();

    expect(requiredEnv).toContain('BETTER_AUTH_SECRET');
    expect(requiredEnv).not.toContain('DISCORD_BOT_TOKEN');
  });

  it('treats the supported CONVEX_URL site-url fallback as an any-of requirement', async () => {
    const requirements = requiredConvexDeploymentEnvRequirements();
    expect(requirements).toContainEqual(['CONVEX_SITE_URL', 'CONVEX_URL']);

    await expect(
      assertRequiredConvexDeploymentEnv({}, [['CONVEX_SITE_URL', 'CONVEX_URL']], async (name) =>
        Promise.resolve(name === 'CONVEX_URL')
      )
    ).resolves.toBeUndefined();
  });

  it('reports only missing deployment variables through the actual assertion', async () => {
    const env = { CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:3210' };
    const isSet = async (name: string) => name === 'BETTER_AUTH_SECRET';

    await expect(
      assertRequiredConvexDeploymentEnv(env, ['BETTER_AUTH_SECRET', 'CONVEX_SITE_URL'], isSet)
    ).rejects.toThrow('Missing required Convex deployment env: CONVEX_SITE_URL');
  });

  it('passes when every required deployment variable is set', async () => {
    await expect(
      assertRequiredConvexDeploymentEnv({}, ['BETTER_AUTH_SECRET'], async () => true)
    ).resolves.toBeUndefined();
  });

  it('reports a failed deployment-env lookup instead of treating it as unset', () => {
    expect(() =>
      deploymentEnvGetIsSet(
        'BETTER_AUTH_SECRET',
        '',
        'Authentication failed for self-hosted Convex',
        1
      )
    ).toThrow('Authentication failed for self-hosted Convex');
  });

  it('treats an explicit unset diagnostic as an unset deployment variable', () => {
    expect(
      deploymentEnvGetIsSet(
        'BETTER_AUTH_SECRET',
        '',
        'Environment variable BETTER_AUTH_SECRET is not set',
        1
      )
    ).toBe(false);
  });
});
