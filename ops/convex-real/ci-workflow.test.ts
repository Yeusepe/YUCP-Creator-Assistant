import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/ci.yml'), 'utf8');
const deployGate = readFileSync(resolve(import.meta.dir, './deploy-gate.ts'), 'utf8');
const compose = readFileSync(resolve(import.meta.dir, './docker-compose.yml'), 'utf8');

const LATEST_SELF_HOSTED_TAG = 'latest';

describe('self-hosted Convex CI workflow', () => {
  it('uses the newest published backend and dashboard images', () => {
    expect(compose).toContain(`convex-backend:${LATEST_SELF_HOSTED_TAG}`);
    expect(compose).toContain(`convex-dashboard:${LATEST_SELF_HOSTED_TAG}`);
  });

  it('runs deploy with Convex codegen and typecheck enabled', () => {
    expect(deployGate).toContain("runSelfHostedConvexCli(['deploy', '-y'], env)");
    expect(deployGate).not.toContain("'--typecheck'");
    expect(deployGate).not.toContain("'--codegen'");
  });

  it('blocks the real backend suite on a successful deploy', () => {
    const realBackendJob = workflow.slice(
      workflow.indexOf('  convex-real:'),
      workflow.indexOf('  e2e-flows:')
    );
    const boot = realBackendJob.indexOf('name: Boot and provision self-hosted Convex');
    const deploy = realBackendJob.indexOf('name: Run real Convex deploy gate');
    const suite = realBackendJob.indexOf('name: Run self-hosted Convex real suite');

    expect(boot).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(boot);
    expect(suite).toBeGreaterThan(deploy);
  });

  it('enables test helpers after the real deploy gate and before E2E flows', () => {
    const e2eJob = workflow.slice(workflow.indexOf('  e2e-flows:'));
    const boot = e2eJob.indexOf('name: Boot and provision self-hosted Convex');
    const deployGate = e2eJob.indexOf('name: Run real Convex deploy gate');
    const testHelpers = e2eJob.indexOf('name: Enable self-hosted real test helpers');
    const e2eFlows = e2eJob.indexOf('name: Run real API user journey flows');

    expect(boot).toBeGreaterThan(-1);
    expect(deployGate).toBeGreaterThan(boot);
    expect(testHelpers).toBeGreaterThan(deployGate);
    expect(e2eFlows).toBeGreaterThan(testHelpers);
  });
});
