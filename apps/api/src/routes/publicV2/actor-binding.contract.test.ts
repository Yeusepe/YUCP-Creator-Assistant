import { describe, expect, it } from 'bun:test';

const convexClientConstructionPattern = /\bgetConvexClientFromUrl\s*\(/g;
const actorBoundConvexClientConstructionPattern =
  /\bgetConvexClientFromUrl\s*\(\s*config\.convexUrl\s*,\s*auth\.actorBinding\s*\)/g;

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
  'verification-intents',
  'verification-sessions',
  'webhooks',
] as const;

describe('publicV2 protected route actor binding contract', () => {
  for (const moduleName of protectedRouteModules) {
    it(`${moduleName} creates its Convex client with the caller actor binding`, async () => {
      const source = await Bun.file(new URL(`./${moduleName}.ts`, import.meta.url)).text();
      const clientConstructionCount = (source.match(convexClientConstructionPattern) ?? []).length;
      const actorBoundClientConstructionCount = (
        source.match(actorBoundConvexClientConstructionPattern) ?? []
      ).length;

      expect(clientConstructionCount).toBeGreaterThan(0);
      expect(actorBoundClientConstructionCount).toBe(clientConstructionCount);
    });
  }
});
