import { describe, expect, test } from 'bun:test';
import { createComposeEnv } from './manage';

describe('createComposeEnv', () => {
  test('does not inherit host database URLs into the disposable backend', () => {
    const env = createComposeEnv({
      DATABASE_URL: 'postgres://prod.example/yucp',
      POSTGRES_URL: 'postgres://staging.example/yucp',
      MYSQL_URL: 'mysql://legacy.example/yucp',
      PATH: '/usr/bin',
    });

    expect(env).toMatchObject({ PATH: '/usr/bin' });
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('POSTGRES_URL');
    expect(env).not.toHaveProperty('MYSQL_URL');
  });

  test('allows explicit Convex real backend database overrides', () => {
    const env = createComposeEnv({
      DATABASE_URL: 'postgres://prod.example/yucp',
      CONVEX_REAL_BACKEND_DATABASE_URL: 'postgres://localhost/convex-real',
      CONVEX_REAL_BACKEND_POSTGRES_URL: 'postgres://localhost/convex-real-pg',
      CONVEX_REAL_BACKEND_MYSQL_URL: 'mysql://localhost/convex-real',
    });

    expect(env.DATABASE_URL).toBe('postgres://localhost/convex-real');
    expect(env.POSTGRES_URL).toBe('postgres://localhost/convex-real-pg');
    expect(env.MYSQL_URL).toBe('mysql://localhost/convex-real');
  });
});
