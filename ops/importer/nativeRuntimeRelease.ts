import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

const EXECUTABLE_FILE_NAME = 'yucp-transfer-helper.exe';
const ROOT_FILE_NAME = '1.root.json';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_ROOT_BYTES = 512 * 1024;
const TRUST_SOURCE_RELATIVE_PATH = 'Editor/PackageManager/Core/NativePackageRuntimeTrust.cs';

type ReleaseArtifact = {
  bytes: Uint8Array;
  fileName: string;
  path: string;
  sha256: string;
};

export type NativeRuntimeRelease = {
  executable: ReleaseArtifact;
  metadataUrl: string;
  publisher: {
    certificateSha256: string;
    subject: string;
    trustMode: NativeRuntimePublisherTrustMode;
  };
  targetsUrl: string;
  trustedRoot: ReleaseArtifact;
};

export type NativeRuntimePublisherTrustMode =
  | 'pinned-development'
  | 'pinned-production'
  | 'system';

type PublisherVerifier = (input: {
  certificateSha256: string;
  executablePath: string;
  subject: string;
  trustMode: NativeRuntimePublisherTrustMode;
}) => Promise<void>;

export type NativeRuntimePublisherIdentity = {
  certificateSha256: string;
  subject: string;
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${name} contains unsupported fields`);
  }
}

function requireSha256(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 value`);
  }
  return value;
}

function requirePublisherSubject(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value.length < 3 ||
    value.length > 1_024 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new Error('The native runtime publisher subject is invalid');
  }
  return value;
}

function requirePublisherTrustMode(value: unknown): NativeRuntimePublisherTrustMode {
  if (value !== 'system' && value !== 'pinned-development' && value !== 'pinned-production') {
    throw new Error('The native runtime publisher trust mode is invalid');
  }
  return value;
}

function requireRepositoryUrl(value: unknown, name: string): string {
  if (typeof value !== 'string' || value !== value.trim() || value.endsWith('/')) {
    throw new Error(`${name} is not canonical`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.toString() !== value
  ) {
    throw new Error(`${name} must use canonical HTTPS or loopback HTTP`);
  }
  return value;
}

function requirePublisherTrustScope(input: {
  metadataUrl: string;
  subject: string;
  targetsUrl: string;
  trustMode: NativeRuntimePublisherTrustMode;
}): void {
  if (input.trustMode === 'system') {
    return;
  }
  const metadataUrl = new URL(input.metadataUrl);
  const targetsUrl = new URL(input.targetsUrl);
  if (input.trustMode === 'pinned-production') {
    if (
      metadataUrl.protocol !== 'https:' ||
      targetsUrl.protocol !== 'https:' ||
      input.subject !== 'CN=YUCP Package Runtime'
    ) {
      throw new Error(
        'The pinned production publisher requires HTTPS repositories and the YUCP runtime identity'
      );
    }
    return;
  }
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (
    metadataUrl.protocol !== 'http:' ||
    !loopbackHosts.has(metadataUrl.hostname) ||
    targetsUrl.protocol !== 'http:' ||
    !loopbackHosts.has(targetsUrl.hostname) ||
    !input.subject.startsWith('CN=YUCP Local Development ')
  ) {
    throw new Error(
      'The pinned development publisher requires loopback repositories and a local identity'
    );
  }
}

async function readExactArtifact(
  releaseRoot: string,
  value: unknown,
  expectedFileName: string,
  maximumBytes: number,
  name: string
): Promise<ReleaseArtifact> {
  const artifact = requireRecord(value, name);
  requireExactKeys(artifact, ['fileName', 'sha256'], name);
  if (artifact.fileName !== expectedFileName) {
    throw new Error(`${name} must use ${expectedFileName}`);
  }
  const expectedSha256 = requireSha256(artifact.sha256, `${name} SHA-256`);
  const artifactPath = join(releaseRoot, expectedFileName);
  const metadata = await lstat(artifactPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximumBytes
  ) {
    throw new Error(`${name} has an invalid file type or length`);
  }
  const bytes = new Uint8Array(await readFile(artifactPath));
  if (sha256(bytes) !== expectedSha256) {
    throw new Error(`${name} does not match its release manifest`);
  }
  return {
    bytes,
    fileName: expectedFileName,
    path: artifactPath,
    sha256: expectedSha256,
  };
}

export async function inspectWindowsPublisher(
  executablePath: string,
  trustMode: NativeRuntimePublisherTrustMode = 'system'
): Promise<NativeRuntimePublisherIdentity> {
  if (process.platform !== 'win32') {
    throw new Error('Native runtime publisher verification requires Windows');
  }
  const script = [
    'Import-Module Microsoft.PowerShell.Security',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:YUCP_RELEASE_EXECUTABLE_PATH',
    "$isPinned = $env:YUCP_RELEASE_PUBLISHER_TRUST_MODE -eq 'pinned-development' -or $env:YUCP_RELEASE_PUBLISHER_TRUST_MODE -eq 'pinned-production'",
    "if ($null -eq $signature.SignerCertificate -or ($signature.Status -ne 'Valid' -and -not ($isPinned -and $signature.Status -eq 'UnknownError'))) { exit 41 }",
    '$certificate = $signature.SignerCertificate',
    '$sha = [System.Security.Cryptography.SHA256]::Create()',
    'try { $digest = $sha.ComputeHash($certificate.RawData) } finally { $sha.Dispose() }',
    "$fingerprint = ([System.BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()",
    '[Console]::Out.Write(($certificate.Subject + [Environment]::NewLine + $fingerprint))',
  ].join('; ');
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const child = Bun.spawn(
    [
      powershell,
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ],
    {
      env: {
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        YUCP_RELEASE_EXECUTABLE_PATH: executablePath,
        YUCP_RELEASE_PUBLISHER_TRUST_MODE: trustMode,
      },
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
      windowsHide: true,
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `The native runtime Authenticode signature is invalid${stderr.trim() ? `: ${stderr.trim()}` : ''}`
    );
  }
  const lines = stdout.split(/\r?\n/);
  return {
    certificateSha256: requireSha256(
      lines[1]?.trim(),
      'The native runtime Authenticode certificate SHA-256'
    ),
    subject: requirePublisherSubject(lines[0]?.trim()),
  };
}

async function verifyWindowsPublisher(input: {
  certificateSha256: string;
  executablePath: string;
  subject: string;
  trustMode: NativeRuntimePublisherTrustMode;
}): Promise<void> {
  const actual = await inspectWindowsPublisher(input.executablePath, input.trustMode);
  if (actual.subject !== input.subject || actual.certificateSha256 !== input.certificateSha256) {
    throw new Error('The native runtime publisher identity does not match its release manifest');
  }
}

async function readReleaseSource(
  path: string,
  maximumBytes: number,
  name: string
): Promise<Uint8Array> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximumBytes
  ) {
    throw new Error(`${name} has an invalid file type or length`);
  }
  return new Uint8Array(await readFile(path));
}

async function publishExactBytes(path: string, bytes: Uint8Array): Promise<void> {
  try {
    if (sha256(new Uint8Array(await readFile(path))) === sha256(bytes)) {
      return;
    }
    throw new Error(`Refusing to replace a different native runtime release file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const temporaryPath = `${path}.partial-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function createNativeRuntimeRelease(input: {
  executablePath: string;
  metadataUrl: string;
  publisherInspector?: (executablePath: string) => Promise<NativeRuntimePublisherIdentity>;
  publisherTrustMode: NativeRuntimePublisherTrustMode;
  releasePath: string;
  targetsUrl: string;
  trustedRootPath: string;
}): Promise<string> {
  if (
    !isAbsolute(input.executablePath) ||
    !isAbsolute(input.releasePath) ||
    !isAbsolute(input.trustedRootPath)
  ) {
    throw new Error('Native runtime release paths must be absolute');
  }
  const executable = await readReleaseSource(
    input.executablePath,
    MAX_EXECUTABLE_BYTES,
    'The native runtime executable'
  );
  const trustedRoot = await readReleaseSource(
    input.trustedRootPath,
    MAX_ROOT_BYTES,
    'The native runtime TUF root'
  );
  const trustMode = requirePublisherTrustMode(input.publisherTrustMode);
  const inspectPublisher =
    input.publisherInspector ??
    ((executablePath: string) => inspectWindowsPublisher(executablePath, trustMode));
  const publisher = await inspectPublisher(input.executablePath);
  const certificateSha256 = requireSha256(
    publisher.certificateSha256,
    'The native runtime publisher certificate SHA-256'
  );
  const subject = requirePublisherSubject(publisher.subject);
  const metadataUrl = requireRepositoryUrl(input.metadataUrl, 'The native runtime metadata URL');
  const targetsUrl = requireRepositoryUrl(input.targetsUrl, 'The native runtime targets URL');
  requirePublisherTrustScope({
    metadataUrl,
    subject,
    targetsUrl,
    trustMode,
  });
  await mkdir(input.releasePath, { recursive: true, mode: 0o700 });
  await publishExactBytes(join(input.releasePath, EXECUTABLE_FILE_NAME), executable);
  await publishExactBytes(join(input.releasePath, ROOT_FILE_NAME), trustedRoot);
  const manifestPath = join(input.releasePath, 'native-runtime-release.json');
  const manifest = new TextEncoder().encode(
    `${JSON.stringify({
      executable: {
        fileName: EXECUTABLE_FILE_NAME,
        sha256: sha256(executable),
      },
      metadataUrl,
      publisher: {
        certificateSha256,
        subject,
        trustMode,
      },
      schemaVersion: 1,
      targetsUrl,
      trustedRoot: {
        fileName: ROOT_FILE_NAME,
        sha256: sha256(trustedRoot),
      },
    })}\n`
  );
  await publishExactBytes(manifestPath, manifest);
  return manifestPath;
}

export async function readNativeRuntimeReleaseManifest(
  manifestPath: string,
  publisherVerifier: PublisherVerifier = verifyWindowsPublisher
): Promise<NativeRuntimeRelease> {
  if (!isAbsolute(manifestPath)) {
    throw new Error('The native runtime release manifest path must be absolute');
  }
  const manifestMetadata = await lstat(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    throw new Error('The native runtime release manifest must be a regular file');
  }
  const exactManifestPath = await realpath(manifestPath);
  const parsed = requireRecord(
    JSON.parse(await readFile(exactManifestPath, 'utf8')),
    'The native runtime release manifest'
  );
  requireExactKeys(
    parsed,
    ['executable', 'metadataUrl', 'publisher', 'schemaVersion', 'targetsUrl', 'trustedRoot'],
    'The native runtime release manifest'
  );
  if (parsed.schemaVersion !== 1) {
    throw new Error('The native runtime release manifest schema is unsupported');
  }
  const publisher = requireRecord(parsed.publisher, 'The native runtime publisher');
  requireExactKeys(
    publisher,
    ['certificateSha256', 'subject', 'trustMode'],
    'The native runtime publisher'
  );
  const releaseRoot = dirname(exactManifestPath);
  const executable = await readExactArtifact(
    releaseRoot,
    parsed.executable,
    EXECUTABLE_FILE_NAME,
    MAX_EXECUTABLE_BYTES,
    'The native runtime executable'
  );
  const trustedRoot = await readExactArtifact(
    releaseRoot,
    parsed.trustedRoot,
    ROOT_FILE_NAME,
    MAX_ROOT_BYTES,
    'The native runtime TUF root'
  );
  const metadataUrl = requireRepositoryUrl(parsed.metadataUrl, 'The native runtime metadata URL');
  const targetsUrl = requireRepositoryUrl(parsed.targetsUrl, 'The native runtime targets URL');
  const subject = requirePublisherSubject(publisher.subject);
  const trustMode = requirePublisherTrustMode(publisher.trustMode);
  requirePublisherTrustScope({
    metadataUrl,
    subject,
    targetsUrl,
    trustMode,
  });
  const release: NativeRuntimeRelease = {
    executable,
    metadataUrl,
    publisher: {
      certificateSha256: requireSha256(
        publisher.certificateSha256,
        'The native runtime publisher certificate SHA-256'
      ),
      subject,
      trustMode,
    },
    targetsUrl,
    trustedRoot,
  };
  await publisherVerifier({
    certificateSha256: release.publisher.certificateSha256,
    executablePath: release.executable.path,
    subject: release.publisher.subject,
    trustMode: release.publisher.trustMode,
  });
  return release;
}

function csharpString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
}

function replaceBlankTrustConstant(source: string, name: string, value: string): string {
  const pattern = new RegExp(`(internal const string ${name} = )"";`, 'g');
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`The importer release trust source must contain one blank ${name} constant`);
  }
  return source.replace(pattern, `$1"${csharpString(value)}";`);
}

function meta(guid: string, folder: boolean): Uint8Array {
  const importer = folder ? 'folderAsset: yes\nDefaultImporter:\n' : 'DefaultImporter:\n';
  return new TextEncoder().encode(
    `fileFormatVersion: 2\nguid: ${guid}\n${importer}  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`
  );
}

export async function buildNativeRuntimePackageOverlay(
  importerPath: string,
  release: NativeRuntimeRelease
): Promise<Record<string, Uint8Array>> {
  const trustSourcePath = join(importerPath, ...TRUST_SOURCE_RELATIVE_PATH.split('/'));
  const trustSourceMetadata = await lstat(trustSourcePath);
  if (!trustSourceMetadata.isFile() || trustSourceMetadata.isSymbolicLink()) {
    throw new Error('The importer release trust source must be a regular file');
  }
  let trustSource = await readFile(trustSourcePath, 'utf8');
  trustSource = replaceBlankTrustConstant(
    trustSource,
    'ExecutableSha256',
    release.executable.sha256
  );
  trustSource = replaceBlankTrustConstant(trustSource, 'MetadataUrl', release.metadataUrl);
  trustSource = replaceBlankTrustConstant(
    trustSource,
    'PublisherCertificateSha256',
    release.publisher.certificateSha256
  );
  trustSource = replaceBlankTrustConstant(
    trustSource,
    'PublisherSubject',
    release.publisher.subject
  );
  trustSource = replaceBlankTrustConstant(
    trustSource,
    'PublisherTrustMode',
    release.publisher.trustMode
  );
  trustSource = replaceBlankTrustConstant(trustSource, 'TargetsUrl', release.targetsUrl);
  trustSource = replaceBlankTrustConstant(
    trustSource,
    'TrustedRootSha256',
    release.trustedRoot.sha256
  );

  return {
    [TRUST_SOURCE_RELATIVE_PATH]: new TextEncoder().encode(trustSource),
    'Editor/PackageManager/Runtime.meta': meta('8055610f48154eb0b0ef31338e39fabc', true),
    'Editor/PackageManager/Runtime/Windows.meta': meta('02b21466476e4a1c83265bef4a937fae', true),
    'Editor/PackageManager/Runtime/Windows/x64.meta': meta(
      '6645640cafb2460799337b244d3e1df4',
      true
    ),
    'Editor/PackageManager/Runtime/Windows/x64/yucp-transfer-helper.exe': release.executable.bytes,
    'Editor/PackageManager/Runtime/Windows/x64/yucp-transfer-helper.exe.meta': meta(
      'd041d54dfb42471e8dc20119d38e3d76',
      false
    ),
    'Editor/PackageManager/Trust.meta': meta('340f562e60ed47d9865887bc1eab0d24', true),
    'Editor/PackageManager/Trust/1.root.json': release.trustedRoot.bytes,
    'Editor/PackageManager/Trust/1.root.json.meta': meta('2e38a63fc8d84685bd07f80e92a1135c', false),
  };
}
