import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const runner = readFileSync(
  resolve(import.meta.dir, '../../apps/api/test/e2e/support/runE2EFlows.ts'),
  'utf8'
);

describe('local E2E real-backend runner', () => {
  it('deploys current functions and enables helpers before user journeys', () => {
    const boot = runner.indexOf("['bun', 'run', 'test:convex:real:up']");
    const deploy = runner.indexOf("['bun', 'run', 'test:convex:deploy']");
    const helpers = runner.indexOf(
      "['bun', 'run', 'ops/convex-real/manage.ts', 'test-signals']"
    );
    const journeys = runner.indexOf("['bun', 'run', 'test:e2e:flows:run']");

    expect(boot).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(boot);
    expect(helpers).toBeGreaterThan(deploy);
    expect(journeys).toBeGreaterThan(helpers);
  });
});
