import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { writeLifecycleEvidenceAtomically } from './localLifecycle';
import {
  buildNodeBrowserDriverArguments,
  buildNodeBrowserDriverEnvironment,
  startNodeBrowserLifecycle,
  startNodeBrowserLifecycleForTest,
  writeBrowserDriverLine,
} from './nodeBrowserLifecycle';
import { parseBrowserDriverRequest } from './nodeBrowserLifecycleProtocol';

describe('Node Playwright browser bridge', () => {
  test('controls a real browser from the Bun lifecycle process', async () => {
    const driver = await startNodeBrowserLifecycle();
    try {
      expect(await driver.smoke()).toEqual({ title: 'Node bridge' });
    } finally {
      await driver.stop();
    }
  }, 30_000);

  test('keeps browser credentials out of argv, stdout, and evidence', async () => {
    const creatorSession = 'creator-enrollment-session-private-value';
    const licenseValue = 'manual-license-private-value';
    const secretEnvironmentName = 'PACKAGE_LIFECYCLE_SECRET_SENTINEL';
    const runId = randomUUID();
    const previousSecretEnvironment = process.env[secretEnvironmentName];
    process.env[secretEnvironmentName] = creatorSession;
    const child = spawn('node', buildNodeBrowserDriverArguments(), {
      cwd: process.cwd(),
      env: buildNodeBrowserDriverEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    const transcript: string[] = [];
    lines.on('line', (line) => transcript.push(line));
    const root = await mkdtemp(join(tmpdir(), 'yucp-browser-credential-proof-'));
    try {
      child.stdin.write(
        `${JSON.stringify({
          method: 'buyerVerify',
          params: {
            catalogProductId: 'test-catalog-product',
            licenseKey: licenseValue,
            webUrl: 'http://localhost:3000',
          },
          runId,
          sequence: 1,
        })}\n`
      );
      const [smokeLine] = await once(lines, 'line');
      expect(JSON.parse(String(smokeLine))).toMatchObject({
        error: {
          code: 'PACKAGE_LIFECYCLE_BROWSER_COMMAND_FAILED',
        },
        ok: false,
        runId,
        sequence: 1,
      });
      child.stdin.write(`${JSON.stringify({ method: 'stop', runId, sequence: 2 })}\n`);
      await once(lines, 'line');
      child.stdin.end();
      await once(child, 'close');

      const processArguments = child.spawnargs.join(' ');
      const stdout = transcript.join('\n');
      expect(processArguments).not.toContain(creatorSession);
      expect(processArguments).not.toContain(licenseValue);
      expect(stdout).not.toContain(creatorSession);
      expect(stdout).not.toContain(licenseValue);

      const environmentProbe = spawn(
        'node',
        ['-e', `process.stdout.write(process.env.${secretEnvironmentName} ?? '<absent>')`],
        {
          cwd: process.cwd(),
          env: buildNodeBrowserDriverEnvironment(),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }
      );
      environmentProbe.stderr.resume();
      const environmentOutput: Buffer[] = [];
      environmentProbe.stdout.on('data', (chunk) => environmentOutput.push(Buffer.from(chunk)));
      await once(environmentProbe, 'close');
      expect(Buffer.concat(environmentOutput).toString('utf8')).toBe('<absent>');

      const evidencePath = join(root, 'evidence.json');
      await writeLifecycleEvidenceAtomically(
        evidencePath,
        {
          blockers: [],
          finishedAt: '2026-07-26T00:00:01.000Z',
          phases: [{ name: 'browser credential boundary', status: 'passed' }],
          runId,
          schemaVersion: 1,
          startedAt: '2026-07-26T00:00:00.000Z',
          status: 'passed',
          traceId: '0123456789abcdef0123456789abcdef',
        },
        { sensitiveValues: [creatorSession, licenseValue] }
      );
      const evidence = await readFile(evidencePath, 'utf8');
      expect(evidence).not.toContain(creatorSession);
      expect(evidence).not.toContain(licenseValue);
    } finally {
      if (previousSecretEnvironment === undefined) {
        delete process.env[secretEnvironmentName];
      } else {
        process.env[secretEnvironmentName] = previousSecretEnvironment;
      }
      lines.close();
      child.kill('SIGTERM');
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  test('drains driver stderr before it can block the protocol', async () => {
    const driver = await startNodeBrowserLifecycleForTest({
      driverArguments: [
        '-e',
        `
          const fs = require('node:fs');
          const readline = require('node:readline');
          fs.writeSync(2, Buffer.alloc(2 * 1024 * 1024, 120));
          const input = readline.createInterface({ input: process.stdin });
          input.on('line', (line) => {
            const request = JSON.parse(line);
            process.stdout.write(JSON.stringify({
              ok: true,
              result: request.method === 'smoke'
                ? { title: 'stderr drained' }
                : { status: 'stopped' },
              runId: request.runId,
              sequence: request.sequence,
            }) + '\\n');
            if (request.method === 'stop') process.exit(0);
          });
        `,
      ],
      requestTimeoutMs: 5_000,
    });
    try {
      expect(await driver.smoke()).toEqual({ title: 'stderr drained' });
    } finally {
      await driver.stop();
    }
  }, 15_000);

  test('terminates the driver and every pending request after a timeout', async () => {
    const driver = await startNodeBrowserLifecycleForTest({
      driverArguments: [
        '-e',
        `
          const readline = require('node:readline');
          const input = readline.createInterface({ input: process.stdin });
          input.on('line', (line) => {
            const request = JSON.parse(line);
            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                ok: true,
                result: { title: 'late response' },
                runId: request.runId,
                sequence: request.sequence,
              }) + '\\n');
            }, 500);
          });
        `,
      ],
      requestTimeoutMs: 50,
      stopTimeoutMs: 1_000,
    });
    try {
      const first = driver.smoke();
      const second = driver.smoke();
      const results = await Promise.allSettled([first, second]);
      expect(results).toMatchObject([
        {
          reason: {
            code: 'PACKAGE_LIFECYCLE_BROWSER_COMMAND_TIMEOUT',
          },
          status: 'rejected',
        },
        {
          reason: {
            code: 'PACKAGE_LIFECYCLE_BROWSER_COMMAND_TIMEOUT',
          },
          status: 'rejected',
        },
      ]);
      await expect(driver.smoke()).rejects.toMatchObject({
        code: 'PACKAGE_LIFECYCLE_BROWSER_COMMAND_TIMEOUT',
      });
    } finally {
      await driver.stop();
    }
  }, 15_000);

  test('awaits a buffered stdin write before resolving the write operation', async () => {
    let writeFinished = false;
    const stream = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        setTimeout(() => {
          writeFinished = true;
          callback();
        }, 50);
      },
    });

    await writeBrowserDriverLine(stream, '{"sequence":1}\n');
    expect(writeFinished).toBe(true);
  });
});

describe('Node browser protocol validation', () => {
  const runId = '12345678-1234-4123-8123-123456789abc';

  test('accepts only the exact finite method contracts', () => {
    const requests = [
      { method: 'smoke', runId, sequence: 1 },
      { method: 'stop', runId, sequence: 2 },
      {
        method: 'buyerNavigate',
        params: { url: 'http://localhost:3000/access/product' },
        runId,
        sequence: 3,
      },
      {
        method: 'buyerAuthorizeUnity',
        params: { authorizationUrl: 'http://localhost:3000/api/auth/oauth2/authorize?state=test' },
        runId,
        sequence: 4,
      },
      {
        method: 'buyerVerify',
        params: {
          catalogProductId: 'catalog-product',
          licenseKey: 'license-key',
          webUrl: 'http://localhost:3000',
        },
        runId,
        sequence: 5,
      },
      {
        method: 'creatorUpload',
        params: {
          packageId: 'com.example.product',
          packagePath: 'C:\\packages\\product.zip',
          productName: 'Product',
          version: '1.0.0',
          webUrl: 'http://localhost:3000',
        },
        runId,
        sequence: 6,
      },
      {
        method: 'creatorEnsureVccLink',
        params: {
          catalogProductId: 'catalog-product',
          webUrl: 'http://localhost:3000',
        },
        runId,
        sequence: 7,
      },
      {
        method: 'enrollPasskeys',
        params: {
          buyerEnrollmentCapability: 'buyer-capability',
          creatorEnrollmentCapability: 'creator-capability',
          webUrl: 'http://localhost:3000',
        },
        runId,
        sequence: 8,
      },
    ];

    for (const request of requests) {
      expect(parseBrowserDriverRequest(request)).toEqual(request);
    }
  });

  test('rejects extra top-level and per-method keys', () => {
    const requests = [
      { extra: true, method: 'smoke', runId, sequence: 1 },
      { method: 'smoke', params: {}, runId, sequence: 1 },
      {
        method: 'buyerNavigate',
        params: {
          extra: true,
          url: 'http://localhost:3000',
        },
        runId,
        sequence: 1,
      },
      {
        method: 'buyerAuthorizeUnity',
        params: {
          authorizationUrl: 'http://localhost:3000/api/auth/oauth2/authorize',
          extra: true,
        },
        runId,
        sequence: 1,
      },
      {
        method: 'buyerVerify',
        params: {
          catalogProductId: 'catalog-product',
          extra: true,
          licenseKey: 'license-key',
          webUrl: 'http://localhost:3000',
        },
        runId,
        sequence: 1,
      },
      {
        method: 'creatorUpload',
        params: {
          extra: true,
          packageId: 'com.example.product',
          packagePath: 'C:\\packages\\product.zip',
          productName: 'Product',
          version: '1.0.0',
          webUrl: 'http://localhost:3000',
        },
        runId,
        sequence: 1,
      },
      {
        method: 'creatorEnsureVccLink',
        params: {
          catalogProductId: 'catalog-product',
          extra: true,
          webUrl: 'http://localhost:3000',
        },
        runId,
        sequence: 1,
      },
      {
        method: 'enrollPasskeys',
        params: {
          buyerEnrollmentCapability: 'buyer-capability',
          creatorEnrollmentCapability: 'creator-capability',
          extra: true,
          webUrl: 'http://localhost:3000',
        },
        runId,
        sequence: 1,
      },
    ];

    for (const request of requests) {
      expect(() => parseBrowserDriverRequest(request)).toThrow(
        'PACKAGE_LIFECYCLE_BROWSER_PROTOCOL_INVALID'
      );
    }
  });

  test('rejects missing, malformed, and oversized values', () => {
    const requests = [
      null,
      [],
      { method: 'smoke', runId, sequence: 0 },
      { method: 'smoke', runId: 'not-a-run-id', sequence: 1 },
      {
        method: 'buyerNavigate',
        params: { url: 'javascript:alert(1)' },
        runId,
        sequence: 1,
      },
      {
        method: 'buyerVerify',
        params: {
          catalogProductId: 'catalog-product',
          licenseKey: 'x'.repeat(4097),
          webUrl: 'http://localhost:3000',
        },
        runId,
        sequence: 1,
      },
      {
        method: 'creatorUpload',
        params: {
          packageId: '',
          packagePath: 'C:\\packages\\product.zip',
          productName: 'Product',
          version: '1.0.0',
          webUrl: 'http://localhost:3000',
        },
        runId,
        sequence: 1,
      },
    ];

    for (const request of requests) {
      expect(() => parseBrowserDriverRequest(request)).toThrow(
        'PACKAGE_LIFECYCLE_BROWSER_PROTOCOL_INVALID'
      );
    }
  });
});
