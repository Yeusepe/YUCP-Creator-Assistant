import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/ci.yml'), 'utf8');
const deployGate = readFileSync(resolve(import.meta.dir, './deploy-gate.ts'), 'utf8');
const compose = readFileSync(resolve(import.meta.dir, './docker-compose.yml'), 'utf8');
const freshnessWorkflow = readFileSync(
  resolve(import.meta.dir, '../../.github/workflows/convex-image-freshness.yml'),
  'utf8'
);
const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')
) as { scripts?: Record<string, string> };

const CONVEX_BACKEND_DIGEST =
  'sha256:104b8bc70e29b31fa4a57551596090bfc9eedc3d1f27fd4b8cd8d0e782b9b070';
const CONVEX_DASHBOARD_DIGEST =
  'sha256:60b04b339d6cd6623057b03e5275329a20011051907ec5e689a38a401cfdc409';

describe('self-hosted Convex CI workflow', () => {
  it('pins backend and dashboard to the reviewed immutable images', () => {
    expect(compose).toContain(`convex-backend@${CONVEX_BACKEND_DIGEST}`);
    expect(compose).toContain(`convex-dashboard@${CONVEX_DASHBOARD_DIGEST}`);
    expect(compose).not.toContain('convex-backend:latest');
    expect(compose).not.toContain('convex-dashboard:latest');
  });

  it('checks pinned-image freshness only outside pull-request CI', () => {
    expect(freshnessWorkflow).toContain('schedule:');
    expect(freshnessWorkflow).toContain('workflow_dispatch:');
    expect(freshnessWorkflow).not.toContain('pull_request:');
    expect(freshnessWorkflow).toContain('bun run test:convex:images:freshness');
  });

  it('runs deploy with Convex codegen and typecheck enabled', () => {
    expect(deployGate).toContain("runSelfHostedConvexCli(['deploy', '-y'], env)");
    expect(deployGate).not.toContain("'--typecheck'");
    expect(deployGate).not.toContain("'--codegen'");
  });

  it('starts the backend before taking the deploy environment lock', () => {
    const main = deployGate.slice(deployGate.indexOf('async function main'));
    const ensureBackend = main.indexOf('await ensureRealBackendUp()');
    const deployLock = main.indexOf('await withSelfHostedConvexEnvFileMovedAside');
    const deploymentPreflight = main.indexOf('await assertRequiredConvexDeploymentEnv');

    expect(ensureBackend).toBeGreaterThan(-1);
    expect(deployLock).toBeGreaterThan(ensureBackend);
    expect(deploymentPreflight).toBeGreaterThan(deployLock);
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

  it('runs the current TUF and authorized delivery suites for the buyer flow', () => {
    const buyerFlow = packageJson.scripts?.['test:flow:e2e:run'];

    expect(buyerFlow).toBe(
      'bun run test:tuf-publisher:e2e && bun run test:materialization:e2e && bun run test:delivery:e2e'
    );
    expect(workflow).toContain('run: bun run test:flow:e2e:run');
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
