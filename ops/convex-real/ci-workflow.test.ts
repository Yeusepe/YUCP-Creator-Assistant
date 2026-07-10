import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/ci.yml'), 'utf8');

describe('self-hosted Convex CI workflow', () => {
  it('enables test helpers after the real deploy gate and before E2E flows', () => {
    const e2eJob = workflow.slice(workflow.indexOf('  e2e-flows:'));
    const deployGate = e2eJob.indexOf('name: Run real Convex deploy gate');
    const testHelpers = e2eJob.indexOf('name: Enable self-hosted real test helpers');
    const e2eFlows = e2eJob.indexOf('name: Run real API user journey flows');

    expect(deployGate).toBeGreaterThan(-1);
    expect(testHelpers).toBeGreaterThan(deployGate);
    expect(e2eFlows).toBeGreaterThan(testHelpers);
  });
});
