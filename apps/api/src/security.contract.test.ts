import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const oauthClientsSource = readFileSync(
  resolve(import.meta.dir, '../../../convex/oauthClients.ts'),
  'utf8'
);
const apiKeysSource = readFileSync(
  resolve(import.meta.dir, '../../../convex/betterAuthApiKeys.ts'),
  'utf8'
);
const authUserSource = readFileSync(
  resolve(import.meta.dir, '../../../convex/lib/authUser.ts'),
  'utf8'
);
const vrchatPluginSource = readFileSync(
  resolve(import.meta.dir, '../../../convex/plugins/vrchat.ts'),
  'utf8'
);
const certificateBillingSyncSource = readFileSync(
  resolve(import.meta.dir, '../../../convex/certificateBillingSync.ts'),
  'utf8'
);
const vrchatClientSource = readFileSync(
  resolve(import.meta.dir, '../../../packages/providers/src/vrchat/client.ts'),
  'utf8'
);

function getExportBlock(source: string, exportName: string): string {
  const start = source.indexOf(`export const ${exportName} = `);
  expect(start).toBeGreaterThanOrEqual(0);
  const remainder = source.slice(start);
  const nextExport = remainder.indexOf('\nexport const ', 1);
  return nextExport === -1 ? remainder : remainder.slice(0, nextExport);
}

function expectInternalApiSecretGuard(
  source: string,
  exportName: string,
  kind: 'query' | 'mutation'
): void {
  const block = getExportBlock(source, exportName);
  expect(block).toContain(`${kind}({`);
  expect(block).toContain('apiSecret: v.string()');
  expect(block).toContain('requireApiSecret(args.apiSecret);');
}

function expectPublicApiSecretGuard(source: string, exportName: string, kind: 'action'): void {
  const block = getExportBlock(source, exportName);
  expect(block).toContain(`${kind}({`);
  expect(block).toContain('apiSecret: v.string()');
  expect(block).toContain('requireApiSecret(args.apiSecret);');
}

describe('security contracts', () => {
  it('keeps OAuth client administration behind apiSecret checks', () => {
    expectInternalApiSecretGuard(oauthClientsSource, 'listOAuthClients', 'query');
    expectInternalApiSecretGuard(oauthClientsSource, 'getOAuthClient', 'query');
    expectInternalApiSecretGuard(oauthClientsSource, 'getOAuthClientPublic', 'query');
    expectInternalApiSecretGuard(oauthClientsSource, 'createOAuthClient', 'mutation');
    expectInternalApiSecretGuard(oauthClientsSource, 'updateOAuthClient', 'mutation');
    expectInternalApiSecretGuard(oauthClientsSource, 'rotateOAuthClientSecret', 'mutation');
    expectInternalApiSecretGuard(oauthClientsSource, 'deleteOAuthClient', 'mutation');
  });

  it('keeps Better Auth API key administration behind apiSecret checks', () => {
    expectInternalApiSecretGuard(apiKeysSource, 'listApiKeys', 'query');
    expectInternalApiSecretGuard(apiKeysSource, 'listApiKeysForAuthUser', 'query');
    expectInternalApiSecretGuard(apiKeysSource, 'getApiKey', 'query');
    expectInternalApiSecretGuard(apiKeysSource, 'createApiKey', 'mutation');
    expectInternalApiSecretGuard(apiKeysSource, 'verifyApiKey', 'mutation');
    expectInternalApiSecretGuard(apiKeysSource, 'updateApiKey', 'mutation');
  });

  it('keeps external certificate billing catalog sync behind apiSecret checks', () => {
    expectPublicApiSecretGuard(certificateBillingSyncSource, 'ensureCatalogFresh', 'action');
  });

  it('routes auth-sensitive logs through the shared logger instead of raw console calls', () => {
    expect(authUserSource).not.toContain('console.');
    expect(authUserSource).toContain('logger.error(');

    expect(vrchatPluginSource).not.toContain('console.');
    expect(vrchatPluginSource).toContain('logger.info(');

    expect(vrchatClientSource).not.toContain('console.');
    expect(vrchatClientSource).toContain('logger.');
  });
});
