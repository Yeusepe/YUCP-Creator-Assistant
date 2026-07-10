import { describe, expect, it } from 'bun:test';

const protectedRouteModules = [
  'audit-log',
  'bindings',
  'collaborators',
  'connections',
  'downloads',
  'entitlements',
  'events',
  'guilds',
  'manual-licenses',
  'me',
  'products',
  'role-rules',
  'settings',
  'subjects',
  'transactions',
  'verification',
  'verification-sessions',
  'webhooks',
] as const;

describe('publicV2 protected route actor binding contract', () => {
  for (const moduleName of protectedRouteModules) {
    it(`${moduleName} creates its Convex client with the caller actor binding`, async () => {
      const source = await Bun.file(new URL(`./${moduleName}.ts`, import.meta.url)).text();

      expect(source).not.toContain('getConvexClientFromUrl(config.convexUrl);');
      expect(source).toContain('getConvexClientFromUrl(config.convexUrl, auth.actorBinding)');
    });
  }
});
