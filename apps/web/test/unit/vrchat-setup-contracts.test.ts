import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const vrchatSetupSource = readFileSync(
  resolve(__dirname, '../../src/routes/setup/vrchat.tsx'),
  'utf8'
);

describe('vrchat setup contracts', () => {
  it('returns connected creators to the dashboard route, preserving server context', () => {
    expect(vrchatSetupSource).toContain("new URL('/dashboard', window.location.origin)");
    expect(vrchatSetupSource).toContain("dashboardUrl.searchParams.set('vrchat', 'connected');");
    expect(vrchatSetupSource).toContain("dashboardUrl.searchParams.set('guild_id', guild_id);");
    expect(vrchatSetupSource).toContain("dashboardUrl.searchParams.set('tenant_id', tenant_id);");
    expect(vrchatSetupSource).not.toContain("new URL('/', window.location.origin)");
  });

  it('treats dashboard connect mode as a form flow even without a setup token', () => {
    expect(vrchatSetupSource).toContain('const allowsTokenlessConnect = isConnectMode;');
    expect(vrchatSetupSource).toContain(
      "setViewState(allowsTokenlessConnect ? 'form' : 'no-token');"
    );
    expect(vrchatSetupSource).toContain('if (!token && !allowsTokenlessConnect)');
    expect(vrchatSetupSource).toContain("return isConnectMode ? '/api/connect/vrchat/session'");
  });

  it('handles recoverable connect errors from the session endpoint inline', () => {
    expect(vrchatSetupSource).toContain('if (data.needsCredentials || data.sessionExpired)');
    expect(vrchatSetupSource).toContain(
      "setError(data.error || 'Verification failed. Please check your credentials.')"
    );
  });
});
