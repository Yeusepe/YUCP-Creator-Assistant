import { describe, expect, it } from 'bun:test';
import { waitForPostgres } from './postgresReadiness';

describe('waitForPostgres', () => {
  it('retries query failures until PostgreSQL accepts SELECT 1', async () => {
    const commands: string[][] = [];
    const retryDelays: number[] = [];
    let probeCount = 0;

    await waitForPostgres({
      containerName: 'postgres-test',
      databaseName: 'catalog_test',
      runDocker: async (args) => {
        commands.push(args);
        if (args.includes('pg_isready')) {
          return { exitCode: 0, stdout: 'accepting connections', stderr: '' };
        }

        probeCount += 1;

        if (probeCount === 1) {
          return {
            exitCode: 2,
            stdout: '',
            stderr: 'FATAL: the database system is starting up (SQLSTATE 57P03)',
          };
        }
        if (probeCount === 2) {
          throw new Error('connection to server failed: Connection refused (ECONNREFUSED)');
        }
        return { exitCode: 0, stdout: '1', stderr: '' };
      },
      sleep: async (delay) => {
        retryDelays.push(delay);
      },
    });

    expect(probeCount).toBe(3);
    expect(commands[0]).toEqual([
      'exec',
      'postgres-test',
      'psql',
      '--username',
      'postgres',
      '--dbname',
      'catalog_test',
      '--no-align',
      '--tuples-only',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      'SELECT 1',
    ]);
    expect(retryDelays).toEqual([100, 200]);
  });
});
