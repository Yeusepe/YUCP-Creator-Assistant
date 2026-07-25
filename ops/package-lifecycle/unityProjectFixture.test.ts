import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  resetUnityProjectFixture,
  resolveLifecycleRunRoot,
} from './unityProjectFixture';

describe('Unity project fixture', () => {
  it('resets the pinned Avatar project deterministically', async () => {
    const scratchPath = await mkdtemp(
      join(tmpdir(), 'yucp-unity-project-fixture-')
    );
    const allowedRunsRoot = join(scratchPath, 'runs');
    const runRoot = join(allowedRunsRoot, 'current');
    const createProject = async ({
      destinationPath,
      templateRoot,
    }: {
      destinationPath: string;
      templateRoot: string;
    }) => {
      await cp(templateRoot, destinationPath, {
        errorOnExist: true,
        force: false,
        recursive: true,
      });
      const manifestPath = join(
        destinationPath,
        'Packages',
        'vpm-manifest.json'
      );
      const manifest = JSON.parse(
        await readFile(manifestPath, 'utf8')
      ) as {
        dependencies: Record<string, { version: string }>;
        locked?: Record<string, { version: string }>;
      };
      manifest.locked = { ...manifest.dependencies };
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, undefined, 2)}\n`,
        'utf8'
      );
      for (const [packageName, dependency] of Object.entries(
        manifest.dependencies
      )) {
        const packagePath = join(
          destinationPath,
          'Packages',
          packageName
        );
        await mkdir(packagePath, { recursive: true });
        await writeFile(
          join(packagePath, 'package.json'),
          `${JSON.stringify(
            {
              name: packageName,
              version: dependency.version,
            },
            undefined,
            2
          )}\n`,
          'utf8'
        );
      }
    };

    const first = await resetUnityProjectFixture({
      allowedRunsRoot,
      createProject,
      runRoot,
    });
    await writeFile(
      join(first.projectPath, 'Assets', 'mutation.txt'),
      'must be removed\n',
      'utf8'
    );
    const second = await resetUnityProjectFixture({
      allowedRunsRoot,
      createProject,
      runRoot,
    });

    expect(second.templateDigest).toBe(first.templateDigest);
    expect(second.projectDigest).toBe(first.projectDigest);
    expect(second.projectDigest).not.toBe(second.templateDigest);
    expect(
      (
        await readFile(
          join(second.projectPath, 'ProjectSettings', 'ProjectVersion.txt'),
          'utf8'
        )
      ).replace(/\r\n/g, '\n')
    ).toBe(
      'm_EditorVersion: 2022.3.22f1\n' +
        'm_EditorVersionWithRevision: 2022.3.22f1 (887be4894c44)\n'
    );
    expect(
      JSON.parse(
        await readFile(
          join(second.projectPath, 'Packages', 'vpm-manifest.json'),
          'utf8'
        )
      )
    ).toMatchObject({
      dependencies: {
        'com.vrchat.avatars': {
          version: '3.7.6',
        },
        'com.vrchat.base': {
          version: '3.7.6',
        },
        'com.vrchat.core.vpm-resolver': {
          version: '0.1.29',
        },
      },
      locked: {
        'com.vrchat.avatars': {
          version: '3.7.6',
        },
        'com.vrchat.base': {
          version: '3.7.6',
        },
        'com.vrchat.core.vpm-resolver': {
          version: '0.1.29',
        },
      },
    });
    for (const packageName of [
      'com.vrchat.avatars',
      'com.vrchat.base',
      'com.vrchat.core.vpm-resolver',
    ]) {
      expect(
        JSON.parse(
          await readFile(
            join(
              second.projectPath,
              'Packages',
              packageName,
              'package.json'
            ),
            'utf8'
          )
        ).name
      ).toBe(packageName);
    }
  });

  it('rejects run roots outside the lifecycle runs directory', () => {
    const allowedRunsRoot = 'C:\\allowed\\package-lifecycle-runs';

    expect(() =>
      resolveLifecycleRunRoot(
        'C:\\outside\\run',
        allowedRunsRoot
      )
    ).toThrow('inside the lifecycle runs directory');
    expect(() =>
      resolveLifecycleRunRoot(
        'relative-run',
        allowedRunsRoot
      )
    ).toThrow('must be absolute');
  });
});
