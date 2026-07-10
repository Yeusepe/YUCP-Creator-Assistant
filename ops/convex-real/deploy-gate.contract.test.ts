import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const adapter = readFileSync(resolve(root, 'convex/betterAuth/adapter.ts'), 'utf8');
const componentApi = readFileSync(
  resolve(root, 'convex/betterAuth/_generated/component.ts'),
  'utf8'
);
const compose = readFileSync(resolve(import.meta.dir, 'docker-compose.yml'), 'utf8');
const deployGate = readFileSync(resolve(import.meta.dir, 'deploy-gate.ts'), 'utf8');

describe('self-hosted Convex deploy gate contract', () => {
  it('keeps adapter.create public inside the component and internal to its parent', () => {
    expect(adapter).toContain('export const create = mutation({');
    expect(adapter).not.toContain('export const create = internalMutation({');
    expect(adapter).toContain('userId: dataRecord.referenceId');

    expect(componentApi).toMatch(
      /create: FunctionReference<\s*"mutation",\s*"internal",\s*\{ input: any/
    );
  });

  it('uses the latest published self-hosted images and a real deploy path', () => {
    expect(compose).toContain('convex-backend:latest');
    expect(compose).toContain('convex-dashboard:latest');
    expect(deployGate).toContain('withSelfHostedConvexEnvFileMovedAside');
    expect(deployGate).toContain("runSelfHostedConvexCli(['deploy', '-y'], env)");
    expect(deployGate).not.toContain("'--typecheck', 'disable'");
    expect(deployGate).not.toContain("'--codegen', 'disable'");
  });
});
