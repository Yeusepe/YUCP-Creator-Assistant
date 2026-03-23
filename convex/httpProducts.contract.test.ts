import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const httpSource = readFileSync(resolve(__dirname, './http.ts'), 'utf8');
const licensesSource = readFileSync(resolve(__dirname, './yucpLicenses.ts'), 'utf8');

describe('/v1/products fast path contract', () => {
  it('reads cached provider products instead of live provider fanout on the interactive path', () => {
    expect(httpSource).not.toContain('fetchLiveProviderProductsForSources({');
    expect(httpSource).toContain('internal.yucpLicenses.getCachedProviderProductsForTenant');
  });

  it('emits Server-Timing for the products route so slow hops are visible in DevTools', () => {
    expect(httpSource).toContain("'Server-Timing'");
    expect(httpSource).toContain("name: 'cached'");
    expect(httpSource).toContain("name: 'total'");
  });

  it('imports Convex polyfills before using runtime timing APIs in the HTTP router', () => {
    expect(httpSource).toContain("import './polyfills';");
  });

  it('defines a cached provider products query backed by local mappings', () => {
    expect(licensesSource).toContain(
      'export const getCachedProviderProductsForTenant = internalQuery('
    );
    expect(licensesSource).toContain(".query('provider_catalog_mappings')");
    expect(licensesSource).toContain(".query('provider_connections')");
  });
});
