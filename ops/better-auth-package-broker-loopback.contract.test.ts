import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dir, '..');

function readRepositoryFile(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

describe('Better Auth package broker loopback contract', () => {
  test('uses the provider RFC 8252 implementation without an application proxy', () => {
    const providerPackage = JSON.parse(
      readRepositoryFile('node_modules/@better-auth/oauth-provider/package.json')
    ) as { version?: string };
    const providerSource = readRepositoryFile(
      'node_modules/@better-auth/oauth-provider/dist/index.mjs'
    );
    const convexHttp = readRepositoryFile('convex/http.ts');
    const convexSchema = readRepositoryFile('convex/schema.ts');
    const apiProxy = readRepositoryFile('apps/api/src/index.ts');
    const clientSeed = readRepositoryFile('convex/seedYucpOAuthClient.ts');
    const devSupervisor = readRepositoryFile('ops/dev-supervisor.ts');
    const deployOperator = readRepositoryFile('ops/convex-deploy.ts');
    const packageManifest = JSON.parse(readRepositoryFile('package.json')) as {
      scripts?: Record<string, string>;
    };
    expect(providerPackage.version).toBe('1.7.0-rc.2');
    expect(providerSource).toContain('Honors RFC 8252');
    expect(providerSource).toContain('isLoopbackIP(reg.hostname)');
    expect(providerSource).toContain('reg.pathname === req.pathname');

    expect(existsSync(path.join(repositoryRoot, 'convex', 'oauthLoopback.ts'))).toBeFalse();
    expect(convexHttp).not.toContain('/api/yucp/oauth/authorize');
    expect(convexHttp).not.toContain('/api/yucp/oauth/callback');
    expect(convexSchema).not.toContain('oauth_loopback_sessions');
    expect(apiProxy).not.toContain('redirect_uri_rewritten');
    expect(apiProxy).not.toContain('/api/yucp/oauth/callback');
    expect(apiProxy).toContain('bindDefaultOAuthResource(requestParams)');
    expect(clientSeed).toContain("const callbackUrl = 'http://127.0.0.1/callback';");
    expect(devSupervisor).toContain(
      'bunx convex dev --run seedYucpOAuthClient:seedPackageBrokerOAuthClient'
    );
    expect(packageManifest.scripts?.['convex:deploy']).toBe('bun run ops/convex-deploy.ts');
    expect(deployOperator.indexOf("['x', 'convex', 'deploy'")).toBeLessThan(
      deployOperator.indexOf("['x', 'convex', 'run', PACKAGE_BROKER_CLIENT_SEED")
    );
  });
});
