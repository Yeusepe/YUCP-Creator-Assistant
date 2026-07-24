import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const adapter = readFileSync(resolve(root, 'convex/betterAuth/adapter.ts'), 'utf8');
const componentApi = readFileSync(
  resolve(root, 'convex/betterAuth/_generated/component.ts'),
  'utf8'
);
const migrationOperator = readFileSync(resolve(root, 'ops/better-auth-v17-migration.ts'), 'utf8');
describe('self-hosted Convex deploy gate contract', () => {
  it('keeps adapter.create public inside the component and internal to its parent', () => {
    expect(adapter).toContain('export const create = adapterApi.create');
    expect(adapter).not.toContain('normalizeApiKeyCreateInput');
    expect(adapter).not.toContain('rawCreate');

    expect(componentApi).toMatch(
      /create: FunctionReference<\s*"mutation",\s*"internal",\s*\{\s*input:\s*\|/
    );
  });

  it('keeps production auth migration mutations internal and explicitly confirmed', () => {
    expect(componentApi).toMatch(
      /v17Migration:\s*\{[\s\S]*auditPage: FunctionReference<\s*"query",\s*"internal"/
    );
    expect(componentApi).toMatch(
      /v17Migration:\s*\{[\s\S]*migratePage: FunctionReference<\s*"mutation",\s*"internal"/
    );
    expect(migrationOperator).toContain("const PRODUCTION_CONFIRMATION = 'better-auth-v17'");
    expect(migrationOperator).toContain("const CLEANUP_CONFIRMATION = 'remove-legacy-auth-fields'");
  });
});
