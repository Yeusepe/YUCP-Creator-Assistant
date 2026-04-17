import { describe, expect, test } from 'bun:test';
import {
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
    ).toEqual([
      'infisical',
      'login',
      '--method=universal-auth',
      '--host=https://app.infisical.com',
      '--plain',
      '--silent',
    ]);
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
