import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const connectRouteSource = readFileSync(resolve(import.meta.dir, './connect.ts'), 'utf8');

describe('connect delete-account contracts', () => {
  it('revokes owned public API keys during account deletion', () => {
    expect(connectRouteSource).toContain('const { apiKeys } = await auth.listApiKeys(request);');
    expect(connectRouteSource).toContain('metadata?.kind === PUBLIC_API_KEY_METADATA_KIND');
    expect(connectRouteSource).toContain('api.betterAuthApiKeys.updateApiKey');
  });
});
