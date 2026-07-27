import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);
const defaultTemplateRoot = join(
  repositoryRoot,
  'ops',
  'fixtures',
  'package-lifecycle',
  'unity-project-template'
);
const defaultLifecycleRunsRoot = join(
  repositoryRoot,
  '.orchestration',
  'package-lifecycle-runs'
);
const expectedProjectVersion =
  'm_EditorVersion: 2022.3.22f1\n' +
  'm_EditorVersionWithRevision: 2022.3.22f1 (887be4894c44)\n';
const excludedProjectRoots = new Set([
  'Library',
  'Logs',
  'Temp',
  'UserSettings',
]);

export interface ResetUnityProjectFixtureOptions {
  allowedRunsRoot?: string;
  createProject?: CreateUnityProject;
  runRoot: string;
  templateRoot?: string;
}

export interface CreateUnityProjectOptions {
  destinationPath: string;
  templateRoot: string;
}

export type CreateUnityProject = (
  options: CreateUnityProjectOptions
) => Promise<void>;

export interface ResetUnityProjectFixtureResult {
  projectDigest: string;
  projectPath: string;
  templateDigest: string;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function isInside(parentPath: string, childPath: string): boolean {
  const pathFromParent = relative(parentPath, childPath);
  return (
    pathFromParent.length > 0 &&
    pathFromParent !== '..' &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

export function resolveLifecycleRunRoot(
  runRoot: string,
  allowedRunsRoot = defaultLifecycleRunsRoot
): string {
  if (!runRoot || !isAbsolute(runRoot)) {
    throw new Error('The lifecycle run root must be absolute.');
  }
  if (!allowedRunsRoot || !isAbsolute(allowedRunsRoot)) {
    throw new Error('The lifecycle runs directory must be absolute.');
  }

  const resolvedRunRoot = resolve(runRoot);
  const resolvedAllowedRoot = resolve(allowedRunsRoot);
  if (!isInside(resolvedAllowedRoot, resolvedRunRoot)) {
    throw new Error(
      'The lifecycle run root must be inside the lifecycle runs directory.'
    );
  }
  return resolvedRunRoot;
}

async function listFixtureFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `The Unity project fixture contains a symbolic link: ${absolutePath}`
        );
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `The Unity project fixture contains an unsupported entry: ${absolutePath}`
        );
      }
      files.push(relative(rootPath, absolutePath).split(sep).join('/'));
    }
  }

  await visit(rootPath);
  return files;
}

async function digestFixture(rootPath: string): Promise<string> {
  const digest = createHash('sha256');
  for (const filePath of await listFixtureFiles(rootPath)) {
    digest.update(filePath);
    digest.update('\0');
    digest.update(await readFile(join(rootPath, ...filePath.split('/'))));
    digest.update('\0');
  }
  return digest.digest('hex');
}

async function validateTemplate(templateRoot: string): Promise<void> {
  const templateInfo = await lstat(templateRoot);
  if (!templateInfo.isDirectory() || templateInfo.isSymbolicLink()) {
    throw new Error('The Unity project fixture must be a directory.');
  }

  const projectVersion = normalizeText(
    await readFile(
      join(templateRoot, 'ProjectSettings', 'ProjectVersion.txt'),
      'utf8'
    )
  );
  if (projectVersion !== expectedProjectVersion) {
    throw new Error('The Unity project fixture has an unsupported Editor version.');
  }

  const vpmManifest = JSON.parse(
    await readFile(
      join(templateRoot, 'Packages', 'vpm-manifest.json'),
      'utf8'
    )
  ) as {
    dependencies?: Record<string, { version?: unknown }>;
  };
  const dependencies = vpmManifest.dependencies;
  if (
    dependencies?.['com.vrchat.base']?.version !== '3.7.6' ||
    dependencies?.['com.vrchat.avatars']?.version !== '3.7.6' ||
    dependencies?.['com.vrchat.core.vpm-resolver']?.version !== '0.1.29'
  ) {
    throw new Error(
      'The Unity project fixture must pin the VRChat Avatar template.'
    );
  }

  for (const excludedRoot of excludedProjectRoots) {
    try {
      await lstat(join(templateRoot, excludedRoot));
      throw new Error(
        `The Unity project fixture contains generated ${excludedRoot} data.`
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        continue;
      }
      throw error;
    }
  }
}

async function createProjectWithVpm({
  destinationPath,
  templateRoot,
}: CreateUnityProjectOptions): Promise<void> {
  const projectName = destinationPath.slice(
    destinationPath.lastIndexOf(sep) + 1
  );
  const projectParent = dirname(destinationPath);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      'dotnet',
      [
        'tool',
        'run',
        'vpm',
        '--',
        'new',
        projectName,
        templateRoot,
        '-p',
        projectParent,
      ],
      {
        cwd: repositoryRoot,
        stdio: 'ignore',
        windowsHide: true,
      }
    );
    child.once('error', rejectPromise);
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`VPM project creation failed with exit code ${code}.`)
      );
    });
  });
}

async function validateMaterializedProject(
  projectPath: string
): Promise<void> {
  const vpmManifest = JSON.parse(
    await readFile(
      join(projectPath, 'Packages', 'vpm-manifest.json'),
      'utf8'
    )
  ) as {
    dependencies?: Record<string, { version?: unknown }>;
    locked?: Record<string, { version?: unknown }>;
  };
  const expectedPackages = new Map([
    ['com.vrchat.avatars', '3.7.6'],
    ['com.vrchat.base', '3.7.6'],
    ['com.vrchat.core.vpm-resolver', '0.1.29'],
  ]);

  for (const [packageName, version] of expectedPackages) {
    if (
      vpmManifest.dependencies?.[packageName]?.version !== version ||
      vpmManifest.locked?.[packageName]?.version !== version
    ) {
      throw new Error(
        `The materialized Unity fixture has an invalid ${packageName} version.`
      );
    }
    const packageManifest = JSON.parse(
      await readFile(
        join(projectPath, 'Packages', packageName, 'package.json'),
        'utf8'
      )
    ) as { name?: unknown; version?: unknown };
    if (
      packageManifest.name !== packageName ||
      packageManifest.version !== version
    ) {
      throw new Error(
        `The materialized Unity fixture is missing ${packageName} ${version}.`
      );
    }
  }
}

export async function resetUnityProjectFixture({
  allowedRunsRoot = defaultLifecycleRunsRoot,
  createProject = createProjectWithVpm,
  runRoot,
  templateRoot = defaultTemplateRoot,
}: ResetUnityProjectFixtureOptions): Promise<ResetUnityProjectFixtureResult> {
  const resolvedRunRoot = resolveLifecycleRunRoot(
    runRoot,
    allowedRunsRoot
  );
  const resolvedTemplateRoot = resolve(templateRoot);
  await validateTemplate(resolvedTemplateRoot);

  const projectPath = join(resolvedRunRoot, 'unity-project');
  const stagingPath = join(
    resolvedRunRoot,
    `.unity-project-staging-${randomUUID()}`
  );
  await mkdir(resolvedRunRoot, { recursive: true });

  try {
    await createProject({
      destinationPath: stagingPath,
      templateRoot: resolvedTemplateRoot,
    });
    await validateMaterializedProject(stagingPath);
    const templateDigest = await digestFixture(resolvedTemplateRoot);
    const stagingDigest = await digestFixture(stagingPath);

    await rm(projectPath, {
      force: true,
      recursive: true,
    });
    await rename(stagingPath, projectPath);
    return {
      projectDigest: stagingDigest,
      projectPath,
      templateDigest,
    };
  } catch (error) {
    await rm(stagingPath, {
      force: true,
      recursive: true,
    });
    throw error;
  }
}

function readArgument(
  argumentsList: readonly string[],
  name: string
): string | undefined {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : undefined;
}

async function main(argumentsList: readonly string[]): Promise<void> {
  const runRoot = readArgument(argumentsList, '--run-root');
  if (!runRoot) {
    throw new Error('Use --run-root with an absolute lifecycle run path.');
  }

  const result = await resetUnityProjectFixture({
    runRoot,
  });
  console.log(
    JSON.stringify({
      event: 'unity_project_fixture.reset',
      projectDigest: result.projectDigest,
      projectPath: result.projectPath,
    })
  );
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
