import { describe, expect, test } from 'bun:test';
import {
  buildInfisicalCliEnv,
  buildInfisicalLoginArgs,
  buildInfisicalRunArgs,
  resolveInfisicalRunConfig,
} from './run-web-worker-infisical';

describe('run-web-worker-infisical', () => {
  test('resolves required Infisical run config from environment', () => {
    expect(
      resolveInfisicalRunConfig({
        INFISICAL_PROJECT_ID: 'project-123',
        INFISICAL_WEB_SECRETS_PATH: '/frontend',
        INFISICAL_TOKEN: 'token-123',
      })
    ).toEqual({
      projectId: 'project-123',
      environment: 'dev',
      path: '/frontend',
      token: 'token-123',
      host: undefined,
      clientId: undefined,
      clientSecret: undefined,
    });
  });

  test('builds a machine-identity login command when no token is preset', () => {
    expect(
      buildInfisicalLoginArgs({
        projectId: 'project-123',
        environment: 'dev',
        path: '/frontend',
        clientId: 'client-123',
        clientSecret: 'secret-123',
        host: 'https://app.infisical.com',
      })
    ).toEqual(['infisical', 'login', '--method=universal-auth', '--plain', '--silent']);
  });

  test('builds Infisical CLI environment with universal-auth credentials and custom domain', () => {
    expect(
      buildInfisicalCliEnv(
        {
          projectId: 'project-123',
          environment: 'dev',
          path: '/frontend',
          clientId: 'client-123',
          clientSecret: 'secret-123',
          host: 'https://app.infisical.com',
        },
        {
          PATH: 'C:\\Windows\\System32',
        }
      )
    ).toEqual({
      PATH: 'C:\\Windows\\System32',
      INFISICAL_DISABLE_UPDATE_CHECK: 'true',
      INFISICAL_API_URL: 'https://app.infisical.com',
      INFISICAL_CLIENT_ID: 'client-123',
      INFISICAL_CLIENT_SECRET: 'secret-123',
      INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: 'client-123',
      INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: 'secret-123',
    });
  });

  test('builds an infisical run --watch command for the web worker', () => {
    expect(
      buildInfisicalRunArgs(
        {
          projectId: 'project-123',
          environment: 'dev',
          path: '/frontend',
        },
        ['bun', 'run', '--filter', '@yucp/web', 'worker:dev']
      )
    ).toEqual([
      'infisical',
      'run',
      '--watch',
      '--projectId=project-123',
      '--env=dev',
      '--path=/frontend',
      '--',
      'bun',
      'run',
      '--filter',
      '@yucp/web',
      'worker:dev',
    ]);
  });
});
