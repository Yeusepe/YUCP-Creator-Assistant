import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDesyncCli } from './desyncCas';
import {
  createDesyncEvaluationStore,
  inspectDesyncIndexToFile,
  makeDesyncIndex,
} from './desyncPackingTestSupport';
import { commandPathEnv, runCommand } from './process';

async function freeTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to allocate a TCP port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function waitForServer(baseUrl: string, authorization: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(baseUrl, { headers: { Authorization: authorization } });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`desync chunk server did not become ready: ${baseUrl}`);
}

async function stopServer(server: ChildProcessWithoutNullStreams): Promise<void> {
  if (server.exitCode !== null) return;
  server.kill();
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      server.kill('SIGKILL');
      resolve();
    }, 5_000);
    server.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

describe('desync authenticated HTTP compressed store', () => {
  let scratchPath: string;
  let server: ChildProcessWithoutNullStreams | undefined;

  beforeAll(async () => {
    await verifyDesyncCli();
    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-desync-http-'));
  });

  afterAll(async () => {
    if (server) await stopServer(server);
    if (scratchPath) await rm(scratchPath, { force: true, recursive: true });
  });

  test('reconstructs through the native compressed store with a scoped bearer value', async () => {
    const artifactPath = join(scratchPath, 'artifact.bin');
    const artifactBytes = randomBytes(24 * 1024 * 1024);
    await writeFile(artifactPath, artifactBytes);
    const store = await createDesyncEvaluationStore({
      rootPath: join(scratchPath, 'source-store'),
      uncompressed: false,
    });
    const indexPath = join(scratchPath, 'artifact.caibx');
    await makeDesyncIndex({
      artifactPath,
      chunkSize: '64:256:1024',
      indexPath,
      store,
    });
    const chunks = await inspectDesyncIndexToFile({
      indexPath,
      outputPath: join(scratchPath, 'chunks.json'),
      store,
    });

    const port = await freeTcpPort();
    const baseUrl = `http://127.0.0.1:${port}/`;
    const authorization = `Bearer ${randomBytes(24).toString('base64url')}`;
    const logPath = join(scratchPath, 'chunk-server.log');
    const runningServer = spawn(
      'desync',
      [
        '--config',
        store.configPath,
        '--digest',
        'sha256',
        'chunk-server',
        '--store',
        store.storePath,
        '--listen',
        `127.0.0.1:${port}`,
        '--authorization',
        authorization,
        '--log',
        logPath,
      ],
      { env: commandPathEnv(), stdio: ['pipe', 'pipe', 'pipe'] }
    );
    server = runningServer;
    let serverStderr = '';
    runningServer.stderr.on('data', (data: Buffer) => {
      serverStderr += data.toString('utf8');
    });
    await waitForServer(baseUrl, authorization);

    const clientConfigPath = join(scratchPath, 'client-config.json');
    await writeFile(
      clientConfigPath,
      `${JSON.stringify({ 'store-options': { [baseUrl]: { 'http-auth': authorization } } })}\n`,
      { mode: 0o600 }
    );
    const outputPath = join(scratchPath, 'reconstructed.bin');
    await runCommand(
      'desync',
      [
        '--config',
        clientConfigPath,
        '--digest',
        'sha256',
        'extract',
        '--concurrency',
        '32',
        '--store',
        baseUrl,
        '--',
        indexPath,
        outputPath,
      ],
      { env: commandPathEnv() }
    );
    expect(await sha256File(outputPath)).toBe(await sha256File(artifactPath));

    const rejected = await fetch(baseUrl, { headers: { Authorization: 'Bearer wrong' } });
    expect(rejected.status).toBe(401);
    await stopServer(runningServer);
    server = undefined;

    const log = await readFile(logPath, 'utf8');
    const chunkGets = log
      .split(/\r?\n/)
      .filter((line) => line.includes('GET') && line.includes('.cacnk'));
    expect(chunkGets.length).toBe(chunks.length);
    expect(log).not.toContain(authorization);
    expect(serverStderr).not.toContain(authorization);
  }, 180_000);
});
