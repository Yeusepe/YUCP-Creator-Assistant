/**
 * Publish the active coupling watermark runtime DLL to Convex.
 *
 * Usage:
 *   bun run convex:publish:coupling-runtime
 *   bun run convex:publish:coupling-runtime -- --version 2026.03.25.153000
 *   bun run convex:publish:coupling-runtime -- --storageId kg2abc123...
 *   bun run convex:publish:coupling-runtime -- --prod --push
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  DEFAULT_COUPLING_RUNTIME_DELIVERY_NAME,
  DEFAULT_COUPLING_RUNTIME_PATH_SEGMENTS,
} from '../convex/lib/couplingRuntimeConfig';

type PublishOptions = {
  version?: string;
  sourcePath?: string;
  storageId?: string;
  deliveryName?: string;
  channel?: string;
  platform?: string;
  codeSigningSubject?: string;
  codeSigningThumbprint?: string;
  prod: boolean;
  push: boolean;
  keepSourceUpload: boolean;
};

function getDefaultRuntimePath(): string {
  return resolve(process.cwd(), ...DEFAULT_COUPLING_RUNTIME_PATH_SEGMENTS);
}

function formatVersionFromDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}.${month}.${day}.${hour}${minute}${second}`;
}

function printUsage(): void {
  console.log(`publish-coupling-runtime

Usage:
  bun run convex:publish:coupling-runtime
  bun run convex:publish:coupling-runtime -- --version 2026.03.25.153000
  bun run convex:publish:coupling-runtime -- --storageId kg2abc123...
  bun run convex:publish:coupling-runtime -- --sourcePath E:\\path\\to\\yucp_watermark.dll
  bun run convex:publish:coupling-runtime -- --prod --push

Options:
  --version <value>                Override the published artifact version.
  --sourcePath <path>              Override the default local DLL path.
  --storageId <id>                 Reuse a file already uploaded to Convex Storage.
  --deliveryName <value>           Override the delivered filename.
  --channel <value>                Override the release channel.
  --platform <value>               Override the release platform.
  --codeSigningSubject <value>     Record a signing subject in artifact metadata.
  --codeSigningThumbprint <value>  Record a signing thumbprint in artifact metadata.
  --keepSourceUpload               Keep the temporary plaintext storage upload after activation.
  --prod                           Run against the default production deployment.
  --push                           Push code before running admin functions.
  --help                           Show this message.

Defaults:
  sourcePath    ${getDefaultRuntimePath()}
  deliveryName  ${DEFAULT_COUPLING_RUNTIME_DELIVERY_NAME}
  version       DLL UTC mtime as YYYY.MM.DD.HHMMSS

Dashboard manual flow:
  1. Upload the DLL in Convex Dashboard → File Storage.
  2. Copy the resulting storageId.
  3. Either run this script with --storageId, or run couplingRuntime:publishUploadedRuntime
     in Convex Dashboard → Functions with that storageId and your chosen version.
`);
}

function buildConvexRunArgs(
  options: PublishOptions,
  functionName: string,
  payload?: unknown,
  includePush = false
): string[] {
  const args = ['bun', 'x', 'convex', 'run', '--typecheck', 'enable'];
  if (options.prod) {
    args.push('--prod');
  }
  if (includePush && options.push) {
    args.push('--push');
  }
  args.push(functionName);
  if (payload !== undefined) {
    args.push(JSON.stringify(payload));
  }
  return args;
}

async function runConvexForString(options: PublishOptions, functionName: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: buildConvexRunArgs(options, functionName, undefined, true),
    env: process.env,
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const [stdoutText, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`${functionName} failed with exit code ${exitCode}`);
  }

  const lines = stdoutText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1) ?? '';
  const value = lastLine.replace(/^['"]|['"]$/g, '');
  if (!value) {
    throw new Error(`${functionName} returned an empty value`);
  }
  return value;
}

async function uploadRuntimeIfNeeded(options: PublishOptions, sourcePath: string): Promise<string> {
  if (options.storageId) {
    return options.storageId;
  }

  const uploadUrl = await runConvexForString(
    options,
    'couplingRuntimeUpload:generateRuntimeUploadUrl'
  );
  if (!/^https?:\/\//i.test(uploadUrl)) {
    throw new Error(`Unexpected upload URL returned by Convex: ${uploadUrl}`);
  }

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: Bun.file(sourcePath),
  });
  if (!response.ok) {
    throw new Error(
      `Convex Storage upload failed with ${response.status} ${response.statusText}: ${await response.text()}`
    );
  }

  const result = (await response.json()) as { storageId?: string };
  const storageId = result.storageId?.trim();
  if (!storageId) {
    throw new Error('Convex Storage upload did not return a storageId');
  }
  return storageId;
}

async function activateRuntime(
  options: PublishOptions,
  storageId: string,
  sourcePath: string,
  includePush: boolean
): Promise<void> {
  const payload = {
    storageId,
    version: options.version,
    deliveryName: options.deliveryName,
    deleteSourceAfterPublish: !options.keepSourceUpload,
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.codeSigningSubject ? { codeSigningSubject: options.codeSigningSubject } : {}),
    ...(options.codeSigningThumbprint
      ? { codeSigningThumbprint: options.codeSigningThumbprint }
      : {}),
  };

  const proc = Bun.spawn({
    cmd: buildConvexRunArgs(
      options,
      'couplingRuntime:publishUploadedRuntime',
      payload,
      includePush
    ),
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`couplingRuntime:publishUploadedRuntime failed with exit code ${exitCode}`);
  }

  console.log(`[publish-coupling-runtime] activated storageId=${storageId}`);
  console.log(`[publish-coupling-runtime] sourcePath=${sourcePath}`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: 'string' },
      sourcePath: { type: 'string' },
      storageId: { type: 'string' },
      deliveryName: { type: 'string' },
      channel: { type: 'string' },
      platform: { type: 'string' },
      codeSigningSubject: { type: 'string' },
      codeSigningThumbprint: { type: 'string' },
      prod: { type: 'boolean', default: false },
      push: { type: 'boolean', default: false },
      keepSourceUpload: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const sourcePath = values.sourcePath?.trim() || getDefaultRuntimePath();
  const usingExistingStorageId = Boolean(values.storageId?.trim());
  if (!usingExistingStorageId && !existsSync(sourcePath)) {
    throw new Error(`Coupling runtime source not found: ${sourcePath}`);
  }

  const version =
    values.version?.trim() ||
    formatVersionFromDate(usingExistingStorageId ? new Date() : statSync(sourcePath).mtime);

  const options: PublishOptions = {
    version,
    sourcePath,
    storageId: values.storageId?.trim(),
    deliveryName: values.deliveryName?.trim() || DEFAULT_COUPLING_RUNTIME_DELIVERY_NAME,
    channel: values.channel?.trim(),
    platform: values.platform?.trim(),
    codeSigningSubject: values.codeSigningSubject?.trim(),
    codeSigningThumbprint: values.codeSigningThumbprint?.trim(),
    prod: values.prod,
    push: values.push,
    keepSourceUpload: values.keepSourceUpload,
  };

  console.log(`[publish-coupling-runtime] version=${version}`);
  console.log(`[publish-coupling-runtime] deployment=${options.prod ? 'prod' : 'current'}`);

  const storageId = await uploadRuntimeIfNeeded(options, sourcePath);
  await activateRuntime(options, storageId, sourcePath, usingExistingStorageId && options.push);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[publish-coupling-runtime]', error);
    process.exit(1);
  });
}
