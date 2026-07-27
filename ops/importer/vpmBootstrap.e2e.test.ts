import { afterAll, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Zippable } from 'fflate';
import { unzipSync, zipSync } from 'fflate';
import { buildYucpAliasVpmPackage } from '../../apps/api/src/routes/vpmAliasPackage';
import { runCommand } from '../storage-core/process';
import { buildLocalImporterRepository } from './localVpmRepository';
import { readNativeRuntimeReleaseManifest } from './nativeRuntimeRelease';

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..');
const DOTNET_SDK_VERSION = '8.0.423';
const VPM_CLI_VERSION = '0.1.28';
const UNITY_VERSION = '2022.3.22f1';
const IMPORTER_PACKAGE_ID = 'com.yucp.importer';
const PACKAGE_ID = 'com.yucp.local-vpm-fixture';
const PUBLIC_ARCHIVE_EXCLUDED_ROOTS = new Set(['Tests', 'Tests.meta']);
const ZIP_TIMESTAMP = new Date('1980-01-02T00:00:00.000Z');

type PackageManifest = Record<string, unknown> & {
  displayName: string;
  name: string;
  version: string;
};

type TestRepositoryState = {
  artifacts: Map<string, Uint8Array>;
  index: Record<string, unknown>;
};

let server: ReturnType<typeof Bun.serve> | undefined;
let scratchPath: string | undefined;

afterAll(async () => {
  server?.stop(true);
  if (scratchPath) {
    await rm(scratchPath, { force: true, recursive: true });
  }
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertPathInsideProjectPackages(unityProjectPath: string, packagePath: string): void {
  const packagesPath = resolve(unityProjectPath, 'Packages');
  const packageRelativePath = relative(packagesPath, resolve(packagePath));
  if (
    !packageRelativePath ||
    packageRelativePath === '..' ||
    packageRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(packageRelativePath)
  ) {
    throw new Error(`Refusing to remove a package outside the disposable project: ${packagePath}`);
  }
}

async function resolveDotnetExecutable(): Promise<string> {
  const configured = process.env.YUCP_DOTNET_EXE?.trim();
  const candidates = [
    configured,
    process.platform === 'win32'
      ? `E:\\YUCPTools\\dotnet-${DOTNET_SDK_VERSION}\\dotnet.exe`
      : undefined,
    'dotnet',
  ].filter((candidate): candidate is string => Boolean(candidate));

  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const result = await runCommand(candidate, ['--list-sdks'], {
        env: process.env,
        timeoutMs: 30_000,
      });
      if (result.stdout.split(/\r?\n/).some((line) => line.startsWith(`${DOTNET_SDK_VERSION} `))) {
        return candidate;
      }
      failures.push(`${candidate}: .NET SDK ${DOTNET_SDK_VERSION} is unavailable`);
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `The VPM acceptance test requires .NET SDK ${DOTNET_SDK_VERSION}.\n${failures.join('\n')}`
  );
}

async function resolveImporterPackagePath(): Promise<string> {
  const configured = process.env.YUCP_IMPORTER_PACKAGE_DIR?.trim();
  const candidates = [
    configured,
    process.platform === 'win32'
      ? 'E:\\Unity\\Components\\YUCP-Components\\Packages\\com.yucp.importer'
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (await pathExists(join(candidate, 'package.json'))) {
      return candidate;
    }
  }

  throw new Error(
    'Set YUCP_IMPORTER_PACKAGE_DIR to the com.yucp.importer package that the VPM test must install'
  );
}

async function resolveUnityExecutable(): Promise<string> {
  const configured = process.env.YUCP_UNITY_EXE?.trim();
  const candidates = [
    configured,
    process.platform === 'win32'
      ? `C:\\Program Files\\Unity\\Hub\\Editor\\${UNITY_VERSION}\\Editor\\Unity.exe`
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Set YUCP_UNITY_EXE to the Unity ${UNITY_VERSION} executable for the VPM alias trigger test`
  );
}

async function buildPackageArchive(
  packagePath: string,
  manifestVersion?: string
): Promise<Uint8Array> {
  const entries: Zippable = {};

  async function addDirectory(directoryPath: string): Promise<void> {
    const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of directoryEntries) {
      const absolutePath = join(directoryPath, entry.name);
      const archivePath = relative(packagePath, absolutePath).split(sep).join('/');
      const archiveRoot = archivePath.split('/', 1)[0];
      if (archiveRoot && PUBLIC_ARCHIVE_EXCLUDED_ROOTS.has(archiveRoot)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`The importer package contains a symbolic link: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        await addDirectory(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`The importer package contains an unsupported entry: ${absolutePath}`);
      }
      let bytes = new Uint8Array(await readFile(absolutePath));
      if (archivePath === 'package.json' && manifestVersion) {
        const manifest = JSON.parse(new TextDecoder().decode(bytes)) as PackageManifest;
        bytes = new TextEncoder().encode(
          `${JSON.stringify({ ...manifest, version: manifestVersion }, null, 2)}\n`
        );
      }
      entries[archivePath] = [bytes, { level: 9, mtime: ZIP_TIMESTAMP }];
    }
  }

  await addDirectory(packagePath);
  return zipSync(entries, { level: 9 });
}

async function writeImporterRuntimeTestHarness(
  unityProjectPath: string,
  importerPackagePath: string
): Promise<void> {
  const testDirectory = join(unityProjectPath, 'Assets', 'ImporterRuntimeTests', 'Editor');
  const sourceDirectory = join(importerPackagePath, 'Tests', 'Editor');
  await mkdir(testDirectory, { recursive: true });
  for (const fileName of [
    'ProjectTransactionJournalTests.cs',
    'VpmAliasTriggerTests.cs',
    'com.yucp.importer.Editor.Tests.asmdef',
  ]) {
    await copyFile(join(sourceDirectory, fileName), join(testDirectory, fileName));
  }
}

async function writeSmartLifecycleUninstallTest(unityProjectPath: string): Promise<void> {
  const testDirectory = join(unityProjectPath, 'Assets', 'ImporterRuntimeTests', 'Editor');
  await writeFile(
    join(testDirectory, 'VpmSmartLifecycleE2ETests.cs'),
    `using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using YUCP.Importer.Editor.PackageManager;
using YUCP.Importer.Editor.PackageManager.Core;

namespace YUCP.Importer.Editor.Tests
{
    public sealed class VpmSmartLifecycleE2ETests
    {
        [UnityTest]
        public IEnumerator UninstallUsesTheInstallRecordAndKeepsTheAliasRegistered()
        {
            string projectRoot = Path.GetFullPath(
                Path.Combine(UnityEngine.Application.dataPath, ".."));
            string aliasId = RequireEnvironment(
                "YUCP_VPM_LIFECYCLE_ALIAS_ID");
            string aliasPackageId = RequireEnvironment(
                "YUCP_VPM_LIFECYCLE_ALIAS_PACKAGE_ID");
            string productDirectory = Path.Combine(
                projectRoot,
                "Assets",
                "YUCP E2E Product");
            Directory.CreateDirectory(productDirectory);
            string unchangedPath = Path.Combine(
                productDirectory,
                "unchanged.txt");
            string modifiedPath = Path.Combine(
                productDirectory,
                "modified.txt");
            File.WriteAllText(unchangedPath, "owned");
            File.WriteAllText(modifiedPath, "owned");

            var state = new PackageDeliveryInstallState
            {
                activeContentDigest = new string('b', 64),
                activePolicyVersion = "active-content-policy-v1",
                aliasId = aliasId,
                releaseRoot = new string('a', 64),
                versionId = "vpm-smart-lifecycle-version",
                files = new List<NativePackageBrokerFile>
                {
                    OwnedFile(
                        "Assets/YUCP E2E Product/unchanged.txt",
                        unchangedPath),
                    OwnedFile(
                        "Assets/YUCP E2E Product/modified.txt",
                        modifiedPath),
                },
            };
            string statePath = Path.Combine(
                projectRoot,
                PackageLifecycleCoordinator.InstallStatePath(aliasId)
                    .Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(statePath));
            File.WriteAllText(
                statePath,
                JsonUtility.ToJson(state, true),
                new UTF8Encoding(false));
            File.WriteAllText(modifiedPath, "user change");

            var alias = new AliasPackageContract
            {
                aliasId = aliasId,
                importerPackage = "com.yucp.importer",
                installStrategy = "server-authorized",
                kind = "alias-v1",
                packageDisplayName = "YUCP E2E Product",
                packageName = aliasPackageId,
                packageVersion = "1.0.0",
            };
            PackageLifecycleExecutionResult result;
            string pipeName =
                "yucp-package-broker-vpm-" +
                Guid.NewGuid().ToString("N");
            using (var server = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous))
            {
                NativePackageBrokerClient.SetTransportForTests(
                    new NamedPipePackageBrokerTransport(pipeName));
                try
                {
                    Task serverTask = RunUninstallBrokerAsync(
                        server,
                        state.releaseRoot);
                    Task<PackageLifecycleExecutionResult> execution =
                        PackageLifecycleCoordinator.ExecuteAsync(
                            alias,
                            "uninstall",
                            "vpm-smart-uninstall",
                            "vpm-smart-uninstall",
                            state.releaseRoot,
                            string.Empty,
                            state.activeContentDigest,
                            state.activePolicyVersion);
                    while (!execution.IsCompleted ||
                        !serverTask.IsCompleted)
                    {
                        yield return null;
                    }
                    result = execution.GetAwaiter().GetResult();
                    serverTask.GetAwaiter().GetResult();
                }
                finally
                {
                    NativePackageBrokerClient.SetTransportForTests(null);
                }
            }

            Assert.That(result.journalState, Is.EqualTo("committed"));
            Assert.That(
                result.currentReleaseRoot,
                Is.EqualTo(PackageLifecycleCoordinator.EmptyReleaseRoot));
            Assert.That(File.Exists(unchangedPath), Is.False);
            Assert.That(
                File.ReadAllText(modifiedPath),
                Is.EqualTo("user change"));
            Assert.That(File.Exists(statePath), Is.False);
            Assert.That(
                File.Exists(
                    Path.Combine(
                        projectRoot,
                        "Packages",
                        aliasPackageId,
                        "package.json")),
                Is.True);

            string vpmManifest = File.ReadAllText(
                Path.Combine(
                    projectRoot,
                    "Packages",
                    "vpm-manifest.json"));
            StringAssert.Contains("\\"dependencies\\"", vpmManifest);
            StringAssert.Contains(
                "\\"" + aliasPackageId + "\\"",
                vpmManifest);
        }

        private static NativePackageBrokerFile OwnedFile(
            string normalizedPath,
            string path)
        {
            return new NativePackageBrokerFile
            {
                bytes = new FileInfo(path).Length,
                normalizedPath = normalizedPath,
                sha256 = Sha256(path),
            };
        }

        private static async Task RunUninstallBrokerAsync(
            NamedPipeServerStream server,
            string expectedReleaseRoot)
        {
            await server.WaitForConnectionAsync().ConfigureAwait(false);
            using (var reader = new StreamReader(
                server,
                new UTF8Encoding(false, true),
                true,
                4096,
                true))
            using (var writer = new StreamWriter(
                server,
                new UTF8Encoding(false, true),
                4096,
                true))
            {
                writer.NewLine = "\\n";
                writer.AutoFlush = true;
                string beginJson = await reader
                    .ReadLineAsync()
                    .ConfigureAwait(false);
                NativePackageBrokerBeginFrame begin =
                    JsonUtility.FromJson<NativePackageBrokerBeginFrame>(
                        beginJson);
                Assert.That(begin.kind, Is.EqualTo("begin"));
                await writer.WriteLineAsync(
                    JsonUtility.ToJson(
                        new NativePackageBrokerChallengeFrame
                        {
                            schemaVersion = 1,
                            kind = "challenge",
                            clientNonce = begin.clientNonce,
                            operationToken = new string('A', 43),
                            expiresAt = DateTimeOffset.UtcNow
                                .AddSeconds(30)
                                .ToString("O"),
                        }))
                    .ConfigureAwait(false);
                string operateJson = await reader
                    .ReadLineAsync()
                    .ConfigureAwait(false);
                NativePackageBrokerOperateFrame operate =
                    JsonUtility.FromJson<NativePackageBrokerOperateFrame>(
                        operateJson);
                Assert.That(
                    operate.request.operation,
                    Is.EqualTo("uninstall"));
                Assert.That(
                    operate.request.expectedCurrentReleaseRoot,
                    Is.EqualTo(expectedReleaseRoot));
                await writer.WriteLineAsync(
                    JsonUtility.ToJson(
                        new NativePackageBrokerServerFrame
                        {
                            schemaVersion = 1,
                            kind = "result",
                            result = new NativePackageBrokerResult
                            {
                                schemaVersion = 3,
                                runId = operate.request.runId,
                                operation = "uninstall",
                                status = "succeeded",
                                exitCode = 0,
                                traceId = new string('a', 32),
                                targetReleaseRoot =
                                    PackageLifecycleCoordinator.EmptyReleaseRoot,
                                activeContentDigest =
                                    operate.request.approvedActiveContentDigest,
                                activePolicyVersion =
                                    operate.request.approvedPolicyVersion,
                                versionId = "uninstalled",
                                logicalBytes = 0,
                                logicalFiles = 0,
                                stagingTree = string.Empty,
                                journalState = "authorized",
                                files = new List<NativePackageBrokerFile>(),
                            },
                        }))
                    .ConfigureAwait(false);
            }
        }

        private static string RequireEnvironment(string name)
        {
            string value = Environment.GetEnvironmentVariable(name);
            Assert.That(value, Is.Not.Null.And.Not.Empty, name);
            return value;
        }

        private static string Sha256(string path)
        {
            using (SHA256 sha256 = SHA256.Create())
            using (FileStream stream = File.OpenRead(path))
            {
                return BitConverter.ToString(sha256.ComputeHash(stream))
                    .Replace("-", string.Empty)
                    .ToLowerInvariant();
            }
        }
    }
}
`
  );
}

async function writeUnityLifecycleStateTest(unityProjectPath: string): Promise<void> {
  const testDirectory = join(unityProjectPath, 'Assets', 'Tests', 'Editor');
  await mkdir(testDirectory, { recursive: true });
  await writeFile(
    join(testDirectory, 'VpmLifecycleStateTests.asmdef'),
    `${JSON.stringify(
      {
        name: 'YUCP.Disposable.VpmLifecycle.Tests',
        rootNamespace: 'YUCP.Disposable.VpmLifecycle.Tests',
        includePlatforms: ['Editor'],
        optionalUnityReferences: ['TestAssemblies'],
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(testDirectory, 'VpmLifecycleStateTests.cs'),
    `using System;
using System.IO;
using NUnit.Framework;
using UnityEngine;

namespace YUCP.Disposable.VpmLifecycle.Tests
{
    public sealed class VpmLifecycleStateTests
    {
        [Serializable]
        private sealed class PackageManifest
        {
            public string name;
            public string version;
        }

        [Test]
        public void PackageStateMatchesTheRequestedLifecyclePhase()
        {
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string aliasPackageId = RequireEnvironment("YUCP_VPM_LIFECYCLE_ALIAS_PACKAGE_ID");
            string importerPackageId = RequireEnvironment("YUCP_VPM_LIFECYCLE_IMPORTER_PACKAGE_ID");
            string importerVersion = RequireEnvironment("YUCP_VPM_LIFECYCLE_IMPORTER_VERSION");
            bool aliasExpected = string.Equals(
                RequireEnvironment("YUCP_VPM_LIFECYCLE_ALIAS_PRESENT"),
                "true",
                StringComparison.Ordinal);

            string aliasManifestPath = Path.Combine(
                projectRoot,
                "Packages",
                aliasPackageId,
                "package.json");
            Assert.That(File.Exists(aliasManifestPath), Is.EqualTo(aliasExpected));

            string importerManifestPath = Path.Combine(
                projectRoot,
                "Packages",
                importerPackageId,
                "package.json");
            Assert.That(File.Exists(importerManifestPath), Is.True);
            PackageManifest manifest = JsonUtility.FromJson<PackageManifest>(
                File.ReadAllText(importerManifestPath));
            Assert.That(manifest, Is.Not.Null);
            Assert.That(manifest.name, Is.EqualTo(importerPackageId));
            Assert.That(manifest.version, Is.EqualTo(importerVersion));
        }

        private static string RequireEnvironment(string name)
        {
            string value = Environment.GetEnvironmentVariable(name);
            Assert.That(value, Is.Not.Null.And.Not.Empty, name);
            return value;
        }
    }
}
`
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function inventoryPackageFiles(packagePath: string): Promise<Record<string, string>> {
  const inventory: Record<string, string> = {};

  async function addDirectory(directoryPath: string): Promise<void> {
    const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of directoryEntries) {
      const absolutePath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await addDirectory(absolutePath);
        continue;
      }
      if (entry.isFile()) {
        const inventoryPath = relative(packagePath, absolutePath).split(sep).join('/');
        inventory[inventoryPath] = sha256(new Uint8Array(await readFile(absolutePath)));
      }
    }
  }

  await addDirectory(packagePath);
  return inventory;
}

function inventoryPackageArchive(archive: Uint8Array): Record<string, string> {
  return Object.fromEntries(
    Object.entries(unzipSync(archive))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, bytes]) => [path, sha256(bytes)])
  );
}

function packageResponse(bytes: Uint8Array, request: Request): Response {
  return new Response(request.method === 'HEAD' ? null : Uint8Array.from(bytes).buffer, {
    status: 200,
    headers: {
      'Content-Length': String(bytes.byteLength),
      'Content-Type': 'application/zip',
    },
  });
}

function vpmEnvironment(dotnetExecutable: string): NodeJS.ProcessEnv {
  const dotnetRoot = isAbsolute(dotnetExecutable)
    ? dirname(dotnetExecutable)
    : process.env.DOTNET_ROOT;
  return {
    ...process.env,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    ...(dotnetRoot ? { DOTNET_ROOT: dotnetRoot } : {}),
    PATH: dotnetRoot ? `${dotnetRoot}${delimiter}${process.env.PATH ?? ''}` : process.env.PATH,
  };
}

async function runVpm(
  dotnetExecutable: string,
  args: string[],
  timeoutMs = 120_000
): Promise<Awaited<ReturnType<typeof runCommand>>> {
  return await runCommand(dotnetExecutable, ['tool', 'run', 'vpm', '--', ...args], {
    cwd: REPOSITORY_ROOT,
    env: vpmEnvironment(dotnetExecutable),
    timeoutMs,
  });
}

async function readInstalledPackageManifest(
  unityProjectPath: string,
  packageId: string
): Promise<PackageManifest> {
  return JSON.parse(
    await readFile(join(unityProjectPath, 'Packages', packageId, 'package.json'), 'utf8')
  ) as PackageManifest;
}

function requireImporterManifest(
  manifests: ReadonlyMap<string, PackageManifest>,
  version: string
): PackageManifest {
  const manifest = manifests.get(version);
  if (!manifest) {
    throw new Error(`The disposable VPM repository is missing importer ${version}`);
  }
  return manifest;
}

function requireImporterArtifact(
  artifacts: ReadonlyMap<string, Uint8Array>,
  version: string
): Uint8Array {
  const suffix = `/${IMPORTER_PACKAGE_ID}-${version}.zip`;
  for (const [path, artifact] of artifacts) {
    if (path.endsWith(suffix)) {
      return artifact;
    }
  }
  throw new Error(`The disposable VPM repository is missing importer artifact ${version}`);
}

async function runUnityLifecyclePhase(input: {
  aliasPackageId: string;
  aliasPresent: boolean;
  evidenceDirectory?: string;
  importerVersion: string;
  phase: string;
  scratchPath: string;
  unityExecutable: string;
  unityProjectPath: string;
}): Promise<void> {
  const unityTestResults = join(input.scratchPath, `vpm-${input.phase}-results.xml`);
  const unityLog = join(input.scratchPath, `vpm-${input.phase}.log`);
  try {
    await runCommand(
      input.unityExecutable,
      [
        '-batchmode',
        '-nographics',
        '-projectPath',
        input.unityProjectPath,
        '-runTests',
        '-testPlatform',
        'EditMode',
        '-testFilter',
        'YUCP.Disposable.VpmLifecycle.Tests.VpmLifecycleStateTests',
        '-testResults',
        unityTestResults,
        '-logFile',
        unityLog,
      ],
      {
        env: {
          ...process.env,
          YUCP_VPM_LIFECYCLE_ALIAS_PACKAGE_ID: input.aliasPackageId,
          YUCP_VPM_LIFECYCLE_ALIAS_PRESENT: input.aliasPresent ? 'true' : 'false',
          YUCP_VPM_LIFECYCLE_IMPORTER_PACKAGE_ID: IMPORTER_PACKAGE_ID,
          YUCP_VPM_LIFECYCLE_IMPORTER_VERSION: input.importerVersion,
        },
        timeoutMs: 180_000,
      }
    );
  } catch (error) {
    const log = await readFile(unityLog, 'utf8').catch(() => '');
    const logTail = log.split(/\r?\n/).slice(-200).join('\n');
    throw new Error(
      `Unity did not accept the VPM ${input.phase} state: ${
        error instanceof Error ? error.message : String(error)
      }\n${logTail}`
    );
  }

  const unityResults = await readFile(unityTestResults, 'utf8');
  expect(unityResults).toContain('result="Passed"');
  expect(unityResults).toContain('passed="1"');
  if (input.evidenceDirectory) {
    await mkdir(input.evidenceDirectory, { recursive: true });
    await copyFile(
      unityTestResults,
      join(input.evidenceDirectory, `vpm-${input.phase}-results.xml`)
    );
    await copyFile(unityLog, join(input.evidenceDirectory, `vpm-${input.phase}.log`));
  }
}

async function runUnitySmartUninstallPhase(input: {
  aliasId: string;
  aliasPackageId: string;
  evidenceDirectory?: string;
  scratchPath: string;
  unityExecutable: string;
  unityProjectPath: string;
}): Promise<void> {
  const unityTestResults = join(input.scratchPath, 'vpm-smart-uninstall-results.xml');
  const unityLog = join(input.scratchPath, 'vpm-smart-uninstall.log');
  try {
    await runCommand(
      input.unityExecutable,
      [
        '-batchmode',
        '-nographics',
        '-projectPath',
        input.unityProjectPath,
        '-runTests',
        '-testPlatform',
        'EditMode',
        '-testFilter',
        'YUCP.Importer.Editor.Tests.VpmSmartLifecycleE2ETests',
        '-testResults',
        unityTestResults,
        '-logFile',
        unityLog,
      ],
      {
        env: {
          ...process.env,
          YUCP_VPM_LIFECYCLE_ALIAS_ID: input.aliasId,
          YUCP_VPM_LIFECYCLE_ALIAS_PACKAGE_ID: input.aliasPackageId,
        },
        timeoutMs: 180_000,
      }
    );
  } catch (error) {
    const log = await readFile(unityLog, 'utf8').catch(() => '');
    const logTail = log.split(/\r?\n/).slice(-200).join('\n');
    const testResults = await readFile(unityTestResults, 'utf8').catch(() => '');
    throw new Error(
      `Unity did not complete the smart VPM uninstall: ${
        error instanceof Error ? error.message : String(error)
      }\n${testResults}\n${logTail}`
    );
  }

  const unityResults = await readFile(unityTestResults, 'utf8');
  expect(unityResults).toContain('result="Passed"');
  expect(unityResults).toContain('passed="1"');
  expect(unityResults).toContain('name="UninstallUsesTheInstallRecordAndKeepsTheAliasRegistered"');
  if (input.evidenceDirectory) {
    await copyFile(
      unityTestResults,
      join(input.evidenceDirectory, 'vpm-smart-uninstall-results.xml')
    );
    await copyFile(unityLog, join(input.evidenceDirectory, 'vpm-smart-uninstall.log'));
  }
}

describe.serial('official VPM CLI bootstrap', () => {
  it('installs the public importer and product alias without paid product bytes', async () => {
    const dotnetExecutable = await resolveDotnetExecutable();
    const unityExecutable = await resolveUnityExecutable();
    const importerPackagePath = await resolveImporterPackagePath();
    const importerPackageJson = JSON.parse(
      await readFile(join(importerPackagePath, 'package.json'), 'utf8')
    ) as PackageManifest;
    expect(importerPackageJson).toMatchObject({
      description: 'Installs licensed YUCP products and supports update, repair, and removal.',
      name: IMPORTER_PACKAGE_ID,
    });
    const nativeRuntimeReleaseManifestPath =
      process.env.YUCP_IMPORTER_NATIVE_RUNTIME_RELEASE_MANIFEST?.trim();
    if (!nativeRuntimeReleaseManifestPath) {
      throw new Error('YUCP_IMPORTER_NATIVE_RUNTIME_RELEASE_MANIFEST is required');
    }
    const nativeRuntimeRelease = await readNativeRuntimeReleaseManifest(
      nativeRuntimeReleaseManifestPath
    );
    expect(String(importerPackageJson.description)).not.toMatch(
      /\b(?:desync|digest|fbx|signature|signed|watermark)\b/i
    );

    const restored = await runCommand(dotnetExecutable, ['tool', 'restore'], {
      cwd: REPOSITORY_ROOT,
      env: vpmEnvironment(dotnetExecutable),
      timeoutMs: 120_000,
    });
    expect(`${restored.stdout}\n${restored.stderr}`).toContain(VPM_CLI_VERSION);

    const version = await runVpm(dotnetExecutable, ['--version']);
    expect(version.stdout.trim()).toStartWith(VPM_CLI_VERSION);

    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-vpm-bootstrap-'));
    const unityProjectPath = join(scratchPath, 'unity-project');
    await mkdir(join(unityProjectPath, 'Assets'), { recursive: true });
    await mkdir(join(unityProjectPath, 'Packages'), { recursive: true });
    await mkdir(join(unityProjectPath, 'ProjectSettings'), { recursive: true });
    await writeFile(
      join(unityProjectPath, 'Packages', 'manifest.json'),
      `${JSON.stringify(
        {
          dependencies: {
            'com.unity.test-framework': '1.1.33',
          },
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      join(unityProjectPath, 'Packages', '.gitignore'),
      '/com.vrchat.*\n!/com.vrchat.core.vpm-resolver\n'
    );
    await writeFile(
      join(unityProjectPath, 'ProjectSettings', 'ProjectVersion.txt'),
      'm_EditorVersion: 2022.3.22f1\n'
    );
    await writeUnityLifecycleStateTest(unityProjectPath);
    await writeImporterRuntimeTestHarness(unityProjectPath, importerPackagePath);
    await writeSmartLifecycleUninstallTest(unityProjectPath);

    const requests: string[] = [];
    let repositoryState: TestRepositoryState | undefined;
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (!repositoryState) {
          return Response.json(
            { error: 'Repository initialization is incomplete' },
            { status: 503 }
          );
        }
        if (url.pathname === '/index.json') {
          return Response.json(repositoryState.index);
        }
        const artifact = repositoryState.artifacts.get(url.pathname);
        if (artifact) {
          return packageResponse(artifact, request);
        }
        return Response.json({ error: 'Not found' }, { status: 404 });
      },
    });

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const importerVersions = [importerPackageJson.version, '0.1.27'] as const;
    const importerArtifacts = new Map<string, Uint8Array>();
    const importerManifests = new Map<string, PackageManifest>();
    for (const version of importerVersions) {
      const pinned =
        version === importerPackageJson.version
          ? await buildLocalImporterRepository({
              baseUrl,
              importerPath: importerPackagePath,
              nativeRuntimeRelease,
            })
          : undefined;
      const bytes = pinned?.archive ?? (await buildPackageArchive(importerPackagePath, version));
      const pinnedManifest = pinned?.index.packages[IMPORTER_PACKAGE_ID].versions[version];
      if (pinned && !pinnedManifest) {
        throw new Error(`Pinned importer repository is missing version ${version}`);
      }
      if (pinnedManifest) {
        expect(pinnedManifest.description).toBe(importerPackageJson.description);
      }
      const path = pinnedManifest
        ? new URL(pinnedManifest.url).pathname
        : `/${IMPORTER_PACKAGE_ID}-${version}.zip`;
      importerArtifacts.set(path, bytes);
      importerManifests.set(version, {
        ...(pinnedManifest
          ? pinnedManifest
          : {
              ...importerPackageJson,
              version,
              url: `${baseUrl}${path}`,
              zipSHA256: sha256(bytes),
            }),
      });
    }
    const currentImporterInventory = inventoryPackageArchive(
      requireImporterArtifact(importerArtifacts, importerPackageJson.version)
    );
    expect(
      currentImporterInventory['Editor/PackageManager/Core/AliasPackageActivationStateStore.cs']
    ).toBeDefined();
    expect(
      currentImporterInventory['Editor/PackageManager/Core/AliasPackageMediaLoader.cs']
    ).toBeDefined();
    expect(
      currentImporterInventory['Editor/PackageManager/Core/VpmBootstrapPackageCleanup.cs']
    ).toBeUndefined();
    expect(
      currentImporterInventory['Editor/PackageManager/Core/VpmBootstrapPackageCleanup.cs.meta']
    ).toBeUndefined();
    const aliasIcon = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6m7yWQAAAABJRU5ErkJggg==',
        'base64'
      )
    );
    const alias = buildYucpAliasVpmPackage({
      aliasId: PACKAGE_ID,
      artifactUrl: `${baseUrl}/api/vpm/alias-publications/${randomUUID()}/1.20660.12345.zip`,
      bootstrapVersion: '1.20660.12345',
      vpmDependencies: {},
      packageMetadata: {
        packageName: 'JAMMR',
        author: 'Druffle',
        description: 'Create and join music sessions in VR.',
        tagline: 'Music together in VR.',
      },
      media: [
        {
          kind: 'icon',
          localPath: 'Documentation~/YUCP/icon.png',
          contentType: 'image/png',
          bytes: aliasIcon,
          sha256: createHash('sha256').update(aliasIcon).digest('hex'),
        },
      ],
    });
    const aliasPath = new URL(alias.manifest.url).pathname;
    const repositoryId = `club.yucp.lifecycle.${randomUUID()}`;
    const indexUrl = `${baseUrl}/index.json`;
    const importerRepositoryVersions: Record<string, PackageManifest> = {
      [importerPackageJson.version]: requireImporterManifest(
        importerManifests,
        importerPackageJson.version
      ),
    };
    repositoryState = {
      artifacts: new Map([...importerArtifacts, [aliasPath, alias.bytes]]),
      index: {
        name: 'YUCP Disposable Lifecycle Repository',
        author: 'YUCP',
        id: repositoryId,
        url: indexUrl,
        packages: {
          [IMPORTER_PACKAGE_ID]: {
            versions: importerRepositoryVersions,
          },
          [alias.packageId]: {
            versions: {
              [alias.manifest.version]: alias.manifest,
            },
          },
        },
      },
    };

    let repositoryAdded = false;
    try {
      const addRepository = await runVpm(dotnetExecutable, ['add', 'repo', indexUrl]);
      repositoryAdded = true;
      expect(`${addRepository.stdout}\n${addRepository.stderr}`).toContain(
        'Added repo YUCP Disposable Lifecycle Repository'
      );

      await runVpm(
        dotnetExecutable,
        ['add', 'package', alias.packageId, '--project', unityProjectPath],
        180_000
      );

      const installedImporter = JSON.parse(
        await readFile(
          join(unityProjectPath, 'Packages', IMPORTER_PACKAGE_ID, 'package.json'),
          'utf8'
        )
      ) as PackageManifest;
      expect(installedImporter).toMatchObject({
        name: IMPORTER_PACKAGE_ID,
        version: importerPackageJson.version,
      });
      expect(
        await inventoryPackageFiles(join(unityProjectPath, 'Packages', IMPORTER_PACKAGE_ID))
      ).toEqual(
        inventoryPackageArchive(
          requireImporterArtifact(importerArtifacts, importerPackageJson.version)
        )
      );
      const packagedTufRootPath = join(
        unityProjectPath,
        'Packages',
        IMPORTER_PACKAGE_ID,
        'Editor',
        'PackageManager',
        'Trust',
        '1.root.json'
      );
      expect(await pathExists(packagedTufRootPath)).toBe(true);
      const packagedTrustSource = await readFile(
        join(
          unityProjectPath,
          'Packages',
          IMPORTER_PACKAGE_ID,
          'Editor',
          'PackageManager',
          'Core',
          'NativePackageRuntimeTrust.cs'
        ),
        'utf8'
      );
      expect(packagedTrustSource).toContain(
        'internal const string PublisherTrustMode = "pinned-development";'
      );
      expect(packagedTrustSource).not.toContain(
        'internal const string ExecutableSha256 = "";'
      );

      const installedAliasPath = join(
        unityProjectPath,
        'Packages',
        alias.packageId,
        'package.json'
      );
      const installedAliasText = await readFile(installedAliasPath, 'utf8');
      const installedAlias = JSON.parse(installedAliasText) as Record<string, unknown>;
      expect(installedAlias).toMatchObject({
        displayName: 'JAMMR',
        description: 'Create and join music sessions in VR.',
        author: {
          name: 'Druffle',
        },
        name: alias.packageId,
        version: alias.manifest.version,
        vpmDependencies: {
          [IMPORTER_PACKAGE_ID]: '>=0.1.36',
        },
        yucp: {
          aliasId: PACKAGE_ID,
          installStrategy: 'server-authorized',
          kind: 'alias-v1',
          packageDisplayName: 'JAMMR',
          packageMetadata: {
            packageName: 'JAMMR',
            author: 'Druffle',
            description: 'Create and join music sessions in VR.',
            tagline: 'Music together in VR.',
          },
        },
      });
      expect(
        await readFile(
          join(unityProjectPath, 'Packages', alias.packageId, 'Documentation~', 'YUCP', 'icon.png')
        )
      ).toEqual(Buffer.from(aliasIcon));
      expect(installedAliasText).not.toContain('versionId');
      expect(installedAliasText).not.toContain('delivery');
      expect(installedAliasText).not.toContain('download');
      expect(installedAliasText).not.toContain('token');

      const vpmManifest = JSON.parse(
        await readFile(join(unityProjectPath, 'Packages', 'vpm-manifest.json'), 'utf8')
      ) as {
        dependencies?: Record<string, { version?: string }>;
        locked?: Record<string, { version?: string }>;
      };
      expect(vpmManifest.dependencies?.[alias.packageId]?.version).toBe(alias.manifest.version);
      expect(vpmManifest.locked?.[IMPORTER_PACKAGE_ID]?.version).toBe(importerPackageJson.version);
      expect(requests).toContain('GET /index.json');

      const importerDirectory = await stat(join(unityProjectPath, 'Packages', IMPORTER_PACKAGE_ID));
      const aliasDirectory = await stat(join(unityProjectPath, 'Packages', alias.packageId));
      expect(importerDirectory.isDirectory()).toBe(true);
      expect(aliasDirectory.isDirectory()).toBe(true);

      const unityTestResults = join(scratchPath, 'vpm-alias-trigger-results.xml');
      const unityLog = join(scratchPath, 'vpm-alias-trigger.log');
      try {
        await runCommand(
          unityExecutable,
          [
            '-batchmode',
            '-nographics',
            '-projectPath',
            unityProjectPath,
            '-runTests',
            '-testPlatform',
            'EditMode',
            '-testFilter',
            'YUCP.Importer.Editor.Tests.VpmAliasTriggerTests',
            '-testResults',
            unityTestResults,
            '-logFile',
            unityLog,
          ],
          {
            env: {
              ...process.env,
              YUCP_VPM_ALIAS_TRIGGER_ALIAS_ID: PACKAGE_ID,
              YUCP_VPM_ALIAS_TRIGGER_PACKAGE_ID: alias.packageId,
            },
            timeoutMs: 180_000,
          }
        );
      } catch (error) {
        const log = await readFile(unityLog, 'utf8').catch(() => '');
        const logTail = log.split(/\r?\n/).slice(-200).join('\n');
        throw new Error(
          `Unity did not accept the VPM alias trigger project: ${
            error instanceof Error ? error.message : String(error)
          }\n${logTail}`
        );
      }
      const unityResults = await readFile(unityTestResults, 'utf8');
      expect(unityResults).toContain('result="Passed"');
      expect(unityResults).toContain('failed="0"');
      expect(unityResults).toContain('name="OfficialVpmAliasContractEntersTheAuthorizedFlow"');
      expect(unityResults).toContain(
        'name="LifecycleCompletionKeepsTheVpmAliasBootstrapRegistered"'
      );
      const evidenceDirectory = process.env.YUCP_PACKAGE_EVIDENCE_DIR?.trim();
      if (evidenceDirectory) {
        await mkdir(evidenceDirectory, { recursive: true });
        await copyFile(unityTestResults, join(evidenceDirectory, 'vpm-alias-trigger-results.xml'));
        await copyFile(unityLog, join(evidenceDirectory, 'vpm-alias-trigger.log'));
      }

      const transactionTestResults = join(scratchPath, 'project-transaction-results.xml');
      const transactionTestLog = join(scratchPath, 'project-transaction.log');
      await runCommand(
        unityExecutable,
        [
          '-batchmode',
          '-nographics',
          '-projectPath',
          unityProjectPath,
          '-runTests',
          '-testPlatform',
          'EditMode',
          '-testFilter',
          'YUCP.Importer.Editor.Tests.ProjectTransactionJournalTests',
          '-testResults',
          transactionTestResults,
          '-logFile',
          transactionTestLog,
        ],
        {
          env: process.env,
          timeoutMs: 180_000,
        }
      );
      const transactionResults = await readFile(transactionTestResults, 'utf8');
      expect(transactionResults).toContain('result="Passed"');
      expect(transactionResults).toContain('failed="0"');
      for (const testName of [
        'ApplyCommitsOnlyPreverifiedStagingFiles',
        'ApplyReadsVerifiedStagingFilesPastTheWindowsPathLimit',
        'ApplyRejectsAConcurrentProjectMutation',
        'ApplyRejectsCorruptStagingBeforeLiveMutation',
        'ApplyRemovesOnlyUnchangedObsoleteOwnedFiles',
        'AssetEditingTransactionAlwaysEndsAfterFailure',
        'InspectReportsCommittedPackageDescriptorChanges',
        'PrepareRejectsAConcurrentProjectMutation',
        'RecoverCommitsAPreparedTransaction',
        'RemoveOwnedFilesPreservesModifiedContent',
        'RollBackCommittedRestoresPriorFiles',
        'RollbackRestoresAnEntryWithADurableBackup',
      ]) {
        expect(transactionResults).toContain(`name="${testName}"`);
      }
      if (evidenceDirectory) {
        await copyFile(
          transactionTestResults,
          join(evidenceDirectory, 'project-transaction-results.xml')
        );
        await copyFile(transactionTestLog, join(evidenceDirectory, 'project-transaction.log'));
      }

      await runUnityLifecyclePhase({
        aliasPackageId: alias.packageId,
        aliasPresent: true,
        evidenceDirectory,
        importerVersion: importerPackageJson.version,
        phase: 'install',
        scratchPath,
        unityExecutable,
        unityProjectPath,
      });

      const rollbackVersion = '0.1.27';
      importerRepositoryVersions[rollbackVersion] = requireImporterManifest(
        importerManifests,
        rollbackVersion
      );
      // Explicit package versions and project resolution follow the official VPM CLI contract.
      // https://vcc.docs.vrchat.com/vpm/cli/
      await runVpm(
        dotnetExecutable,
        [
          'add',
          'package',
          `${IMPORTER_PACKAGE_ID}@${rollbackVersion}`,
          '--project',
          unityProjectPath,
        ],
        180_000
      );
      expect(
        await readInstalledPackageManifest(unityProjectPath, IMPORTER_PACKAGE_ID)
      ).toMatchObject({
        name: IMPORTER_PACKAGE_ID,
        version: rollbackVersion,
      });
      await runUnityLifecyclePhase({
        aliasPackageId: alias.packageId,
        aliasPresent: true,
        evidenceDirectory,
        importerVersion: rollbackVersion,
        phase: 'rollback',
        scratchPath,
        unityExecutable,
        unityProjectPath,
      });

      const repairProbeRelativePath =
        'Editor/PackageManager/Core/AliasPackageActivationStateStore.cs';
      const expectedRepairProbeHash = inventoryPackageArchive(
        requireImporterArtifact(importerArtifacts, rollbackVersion)
      )[repairProbeRelativePath];
      if (!expectedRepairProbeHash) {
        throw new Error('The importer repair probe is missing from the rollback archive');
      }
      const repairProbePath = join(
        unityProjectPath,
        'Packages',
        IMPORTER_PACKAGE_ID,
        ...repairProbeRelativePath.split('/')
      );
      await writeFile(repairProbePath, 'corrupt lifecycle fixture\n');
      expect(sha256(new Uint8Array(await readFile(repairProbePath)))).not.toBe(
        expectedRepairProbeHash
      );
      const installedImporterPath = join(unityProjectPath, 'Packages', IMPORTER_PACKAGE_ID);
      assertPathInsideProjectPackages(unityProjectPath, installedImporterPath);
      await rm(installedImporterPath, { force: true, recursive: true });
      await runVpm(dotnetExecutable, ['resolve', 'project', unityProjectPath], 180_000);
      expect(sha256(new Uint8Array(await readFile(repairProbePath)))).toBe(expectedRepairProbeHash);
      await runUnityLifecyclePhase({
        aliasPackageId: alias.packageId,
        aliasPresent: true,
        evidenceDirectory,
        importerVersion: rollbackVersion,
        phase: 'repair',
        scratchPath,
        unityExecutable,
        unityProjectPath,
      });

      await runVpm(
        dotnetExecutable,
        [
          'add',
          'package',
          `${IMPORTER_PACKAGE_ID}@${importerPackageJson.version}`,
          '--project',
          unityProjectPath,
        ],
        180_000
      );
      expect(
        await readInstalledPackageManifest(unityProjectPath, IMPORTER_PACKAGE_ID)
      ).toMatchObject({
        name: IMPORTER_PACKAGE_ID,
        version: importerPackageJson.version,
      });
      await runUnityLifecyclePhase({
        aliasPackageId: alias.packageId,
        aliasPresent: true,
        evidenceDirectory,
        importerVersion: importerPackageJson.version,
        phase: 'update',
        scratchPath,
        unityExecutable,
        unityProjectPath,
      });

      await runUnitySmartUninstallPhase({
        aliasId: PACKAGE_ID,
        aliasPackageId: alias.packageId,
        evidenceDirectory,
        scratchPath,
        unityExecutable,
        unityProjectPath,
      });
      expect(
        await pathExists(join(unityProjectPath, 'Assets', 'YUCP E2E Product', 'unchanged.txt'))
      ).toBe(false);
      expect(
        await readFile(join(unityProjectPath, 'Assets', 'YUCP E2E Product', 'modified.txt'), 'utf8')
      ).toBe('user change');
      const installStateDigest = sha256(
        new TextEncoder().encode(`yucp:package-install-state:v1\n${PACKAGE_ID}`)
      );
      expect(
        await pathExists(
          join(unityProjectPath, '.yucp', 'package-installs', `${installStateDigest}.json`)
        )
      ).toBe(false);
      expect(await pathExists(join(unityProjectPath, 'Packages', alias.packageId))).toBe(true);
      const uninstalledVpmManifest = JSON.parse(
        await readFile(join(unityProjectPath, 'Packages', 'vpm-manifest.json'), 'utf8')
      ) as {
        dependencies?: Record<string, { version?: string }>;
        locked?: Record<string, { version?: string }>;
      };
      expect(uninstalledVpmManifest.dependencies?.[alias.packageId]?.version).toBe(
        alias.manifest.version
      );
      await runUnityLifecyclePhase({
        aliasPackageId: alias.packageId,
        aliasPresent: true,
        evidenceDirectory,
        importerVersion: importerPackageJson.version,
        phase: 'uninstall',
        scratchPath,
        unityExecutable,
        unityProjectPath,
      });
    } finally {
      if (repositoryAdded) {
        await runVpm(dotnetExecutable, ['remove', 'repo', repositoryId]);
      }
    }

    const listedRepositories = await runVpm(dotnetExecutable, ['list', 'repos']);
    expect(`${listedRepositories.stdout}\n${listedRepositories.stderr}`).not.toContain(
      repositoryId
    );
    expect(basename(importerPackagePath)).toBe(IMPORTER_PACKAGE_ID);
  }, 900_000);
});
