import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createOrUpdateCloudflareWorkerSync,
  loginWithUniversalAuth,
  resolveSetupSyncConfig,
} from './setup-infisical-cloudflare-worker-sync';

describe('setup-infisical-cloudflare-worker-sync', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  test('resolves sync setup config from environment and defaults', () => {
    process.env.INFISICAL_CLIENT_ID = 'client-id';
    process.env.INFISICAL_CLIENT_SECRET = 'client-secret';
    process.env.INFISICAL_PROJECT_ID = 'project-id';
    process.env.INFISICAL_CLOUDFLARE_CONNECTION_ID = 'connection-id';
    process.env.INFISICAL_ENV = 'prod';
    process.env.INFISICAL_WEB_SECRETS_PATH = '/';

    const config = resolveSetupSyncConfig();

    expect(config.projectId).toBe('project-id');
    expect(config.connectionId).toBe('connection-id');
    expect(config.environment).toBe('prod');
    expect(config.secretPath).toBe('/');
    expect(config.scriptId).toBe('yucp-creator-assistant-dashboard');
    expect(config.autoSync).toBe(true);
  });

  test('logs in with universal auth and returns the access token', async () => {
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          accessToken: 'access-token-123',
          expiresIn: 3600,
          accessTokenMaxTTL: 3600,
          tokenType: 'Bearer',
        }),
        { status: 200 }
      );
    });

    const token = await loginWithUniversalAuth(
      {
        infisicalUrl: 'https://app.infisical.com',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      },
      fetchMock as unknown as typeof fetch
    );

    expect(token).toBe('access-token-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('updates an existing matching sync and triggers a manual sync', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input.toString() : input.toString();

      if (url.endsWith('/api/v1/auth/universal-auth/login')) {
        return new Response(
          JSON.stringify({
            accessToken: 'access-token-123',
            expiresIn: 3600,
            accessTokenMaxTTL: 3600,
            tokenType: 'Bearer',
          }),
          { status: 200 }
        );
      }

      if (url.includes('/api/v1/secret-syncs/cloudflare-workers?projectId=')) {
        return new Response(
          JSON.stringify({
            secretSyncs: [
              {
                id: 'sync-123',
                name: 'existing-sync',
                projectId: 'project-id',
                connectionId: 'connection-id',
                environment: { slug: 'prod' },
                folder: { path: '/' },
                destinationConfig: { scriptId: 'yucp-creator-assistant-dashboard' },
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/api/v1/secret-syncs/cloudflare-workers/sync-123')) {
        expect(init?.method).toBe('PATCH');
        return new Response(
          JSON.stringify({
            secretSync: {
              id: 'sync-123',
              syncStatus: 'pending',
            },
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/api/v1/secret-syncs/cloudflare-workers/sync-123/sync-secrets')) {
        expect(init?.method).toBe('POST');
        return new Response(
          JSON.stringify({
            secretSync: {
              id: 'sync-123',
              syncStatus: 'succeeded',
            },
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await createOrUpdateCloudflareWorkerSync(
      {
        infisicalUrl: 'https://app.infisical.com',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        projectId: 'project-id',
        connectionId: 'connection-id',
        environment: 'prod',
        secretPath: '/',
        scriptId: 'yucp-creator-assistant-dashboard',
        syncName: 'dashboard-sync',
        description: 'sync dashboard secrets',
        autoSync: true,
      },
      fetchMock as unknown as typeof fetch
    );

    expect(result).toEqual({
      syncId: 'sync-123',
      action: 'updated',
      syncStatus: 'succeeded',
    });
  });

  test('does not match a sync from another Cloudflare connection', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input.toString() : input.toString();

      if (url.endsWith('/api/v1/auth/universal-auth/login')) {
        return new Response(JSON.stringify({ accessToken: 'access-token-123' }), { status: 200 });
      }

      if (url.includes('/api/v1/secret-syncs/cloudflare-workers?projectId=')) {
        return new Response(
          JSON.stringify({
            secretSyncs: [
              {
                id: 'sync-wrong-connection',
                name: 'existing-sync',
                projectId: 'project-id',
                connectionId: 'other-connection',
                environment: { slug: 'prod' },
                folder: { path: '/' },
                destinationConfig: { scriptId: 'yucp-creator-assistant-dashboard' },
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/api/v1/secret-syncs/cloudflare-workers')) {
        expect(init?.method).toBe('POST');
        return new Response(
          JSON.stringify({
            secretSync: {
              id: 'sync-created',
              syncStatus: 'pending',
            },
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/api/v1/secret-syncs/cloudflare-workers/sync-created/sync-secrets')) {
        return new Response(
          JSON.stringify({
            secretSync: {
              id: 'sync-created',
              syncStatus: 'succeeded',
            },
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await createOrUpdateCloudflareWorkerSync(
      {
        infisicalUrl: 'https://app.infisical.com',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        projectId: 'project-id',
        connectionId: 'connection-id',
        environment: 'prod',
        secretPath: '/',
        scriptId: 'yucp-creator-assistant-dashboard',
        syncName: 'dashboard-sync',
        description: 'sync dashboard secrets',
        autoSync: true,
      },
      fetchMock as unknown as typeof fetch
    );

    expect(result).toEqual({
      syncId: 'sync-created',
      action: 'created',
      syncStatus: 'succeeded',
    });
  });
});
