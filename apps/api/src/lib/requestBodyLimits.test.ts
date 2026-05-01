/**
 * Purpose: Locks the API body limit above real Backstage package artifact sizes.
 * Governing docs:
 * - docs/review-playbook.md
 * - README.md
 * External references:
 * - https://bun.sh/reference/bun/Serve/maxRequestBodySize
 * Tests:
 * - apps/api/src/lib/requestBodyLimits.test.ts
 */

import { expect, it } from 'bun:test';

import { MAX_BACKSTAGE_PACKAGE_BYTES, MAX_BACKSTAGE_UPLOAD_BYTES } from './requestBodyLimits';

it('allows production-size Backstage unitypackage uploads through the API server', () => {
  const songThingPackageBytes = 226_484_608;

  expect(MAX_BACKSTAGE_UPLOAD_BYTES).toBeGreaterThan(songThingPackageBytes);
  expect(MAX_BACKSTAGE_UPLOAD_BYTES).toBeGreaterThanOrEqual(1024 * 1024 * 1024);
});

it('documents the Unity package upper bound enforced by the direct CDNgine upload flow', () => {
  expect(MAX_BACKSTAGE_PACKAGE_BYTES).toBe(5 * 1024 * 1024 * 1024);
});
