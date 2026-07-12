import { expect, test } from 'bun:test';
import { MAX_BACKSTAGE_PACKAGE_BYTES } from './index';

test('uses the canonical five GiB Backstage package limit', () => {
  expect(MAX_BACKSTAGE_PACKAGE_BYTES).toBe(5 * 1024 * 1024 * 1024);
});
