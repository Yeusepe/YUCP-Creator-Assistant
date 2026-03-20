import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const routerSource = readFileSync(resolve(__dirname, '../../src/router.tsx'), 'utf8');
const dashboardRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/dashboard.tsx'),
  'utf8'
);

describe('router search contracts', () => {
  it('serializes dashboard search params as plain strings instead of JSON-quoted values', () => {
    expect(routerSource).toContain('parseSearch: (search)');
    expect(routerSource).toContain('stringifySearch: (search)');
    expect(routerSource).toContain('new URLSearchParams(');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: checking for literal template syntax in source
    expect(routerSource).toContain("return serialized ? `?${serialized}` : '';");
  });

  it('normalizes dashboard search params before route code reads them', () => {
    expect(dashboardRouteSource).toContain('normalizeDashboardIdentifier');
    expect(dashboardRouteSource).toContain('guild_id: normalizeDashboardIdentifier');
    expect(dashboardRouteSource).toContain('tenant_id: normalizeDashboardIdentifier');
  });
});
