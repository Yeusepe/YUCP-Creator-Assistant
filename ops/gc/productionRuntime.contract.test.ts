import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildDevCommands } from '../dev-supervisor';

type RootPackage = {
  scripts?: Record<string, string>;
};

describe('exact-version garbage collection operational ownership', () => {
  test('exposes one deployable janitor and includes it in the complete local topology', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(process.cwd(), 'package.json'), 'utf8')
    ) as RootPackage;

    expect(packageJson.scripts?.['storage:gc:serve']).toBe(
      'bun run --env-file=.env.infisical ops/gc/server.ts'
    );
    expect(
      buildDevCommands({}, false).find((command) => command.name === 'storage-gc')
    ).toMatchObject({
      command: 'bun run ops/gc/server.ts',
      required: true,
    });
  });
});
