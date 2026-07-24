import { describe, expect, it } from 'bun:test';
import { parseBetterAuthV17MigrationOptions } from './better-auth-v17-migration';

describe('Better Auth 1.7 migration operator', () => {
  it('defaults to a read-only development audit', () => {
    expect(parseBetterAuthV17MigrationOptions([])).toEqual({
      deployment: 'dev',
      phase: 'audit',
      pageSize: 100,
    });
  });

  it('requires an explicit production confirmation for mutations', () => {
    expect(() => parseBetterAuthV17MigrationOptions(['--prod', '--phase', 'backfill'])).toThrow(
      'Production migration requires --confirm-production=better-auth-v17'
    );
  });

  it('accepts a confirmed production backfill', () => {
    expect(
      parseBetterAuthV17MigrationOptions([
        '--prod',
        '--phase',
        'backfill',
        '--confirm-production=better-auth-v17',
        '--page-size',
        '75',
      ])
    ).toEqual({
      deployment: 'prod',
      phase: 'backfill',
      pageSize: 75,
    });
  });

  it('requires a separate destructive confirmation for cleanup', () => {
    expect(() =>
      parseBetterAuthV17MigrationOptions([
        '--prod',
        '--phase',
        'cleanup',
        '--confirm-production=better-auth-v17',
      ])
    ).toThrow('Cleanup requires --confirm-cleanup=remove-legacy-auth-fields');
  });

  it('rejects unknown arguments and unbounded page sizes', () => {
    expect(() => parseBetterAuthV17MigrationOptions(['--unknown'])).toThrow(
      'Unknown argument: --unknown'
    );
    expect(() => parseBetterAuthV17MigrationOptions(['--page-size', '501'])).toThrow(
      'Page size must be between 1 and 200'
    );
  });
});
