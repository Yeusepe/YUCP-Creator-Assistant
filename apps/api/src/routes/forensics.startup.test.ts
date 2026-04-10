import { expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFakeConvexServer } from '../../test/helpers/fakeConvex';
import { strToU8, zipSync } from 'fflate';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const START_API_FROM_CWD_PATH = path.resolve(
  import.meta.dir,
  '..',
  '..',
  'test',
  'helpers',
  'startApiFromCwd.ts'
);
const SERVICE_BOOT_TIMEOUT_MS = 60_000;
const TEST_INTERNAL_SECRET = 'test-internal-rpc-secret-32-chars!!';
const WRONG_LEGACY_COUPLING_SECRET = 'legacy-coupling-secret-from-env';
const INFISICAL_CLIENT_ID = 'forensics-test-client-id';
const INFISICAL_CLIENT_SECRET = 'forensics-test-client-secret';
const INFISICAL_PROJECT_ID = 'forensics-test-project-id';
const INFISICAL_ACCESS_TOKEN = 'forensics-test-access-token';
const COUPLING_SHARED_SECRET = 'forensics-secret-from-infisical';

class ManagedProcess {
  private readonly child: ChildProcess;
  private stdoutBuffer = '';
  private stderrBuffer = '';

  constructor(args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!this.child.stdout || !this.child.stderr) {
      throw new Error(`Failed to spawn process: ${args.join(' ')}`);
    }
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
    });
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk;
    });
  }

  async waitForOutput(pattern: RegExp, timeoutMs = SERVICE_BOOT_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(this.stdoutBuffer) || pattern.test(this.stderrBuffer)) {
        return;
      }
      if (this.child.exitCode !== null) {
        throw new Error(
          `Process exited before emitting ${pattern}: stdout=${this.stdoutBuffer}\nstderr=${this.stderrBuffer}`
        );
      }
      await delay(250);
    }
    throw new Error(
      `Timed out waiting for ${pattern}: stdout=${this.stdoutBuffer}\nstderr=${this.stderrBuffer}`
    );
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) {
      return;
    }

    this.child.kill('SIGTERM');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        return;
      }
      await delay(250);
    }
    this.child.kill('SIGKILL');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHealthcheck(baseUrl: string): Promise<void> {
  const deadline = Date.now() + SERVICE_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/health', baseUrl));
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for API healthcheck at ${baseUrl}`);
}

test(
  'loads Infisical bootstrap credentials from local .env.infisical before running forensics lookup',
  async () => {
    const apiPort = await getFreePort();
    const infisicalPort = await getFreePort();
    const couplingPort = await getFreePort();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yucp-forensics-startup-'));

    let loginRequestCount = 0;
    let secretListRequestCount = 0;
    let receivedCouplingAuthorization = '';

    const infisicalServer = Bun.serve({
      port: infisicalPort,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === '/api/v1/auth/universal-auth/login' && request.method === 'POST') {
          loginRequestCount += 1;
          const payload = (await request.json()) as {
            clientId?: string;
            clientSecret?: string;
          };
          if (
            payload.clientId !== INFISICAL_CLIENT_ID ||
            payload.clientSecret !== INFISICAL_CLIENT_SECRET
          ) {
            return Response.json({ error: 'Invalid credentials' }, { status: 401 });
          }
          return Response.json({ accessToken: INFISICAL_ACCESS_TOKEN });
        }

        if (url.pathname === '/api/v3/secrets/raw' && request.method === 'GET') {
          secretListRequestCount += 1;
          if (
            request.headers.get('authorization') !== `Bearer ${INFISICAL_ACCESS_TOKEN}` ||
            url.searchParams.get('workspaceId') !== INFISICAL_PROJECT_ID ||
            url.searchParams.get('environment') !== 'dev'
          ) {
            return Response.json({ error: 'Forbidden' }, { status: 403 });
          }

          return Response.json({
            secrets: [
              {
                secretKey: 'YUCP_COUPLING_SERVICE_SHARED_SECRET',
                secretValue: COUPLING_SHARED_SECRET,
              },
            ],
          });
        }

        return new Response('Not found', { status: 404 });
      },
    });

    const couplingServer = Bun.serve({
      port: couplingPort,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname !== '/v1/coupling/forensic-score' || request.method !== 'POST') {
          return new Response('Not found', { status: 404 });
        }

        receivedCouplingAuthorization = request.headers.get('authorization') ?? '';
        if (receivedCouplingAuthorization !== `Bearer ${COUPLING_SHARED_SECRET}`) {
          return Response.json(
            {
              error:
                'Missing or invalid Authorization bearer [TOKEN_REDACTED] or x-coupling-service-secret header',
            },
            { status: 401 }
          );
        }

        const payload = (await request.json()) as {
          assets?: Array<{ assetPath?: string; assetType?: string }>;
        };
        const assets = Array.isArray(payload.assets) ? payload.assets : [];

        return Response.json({
          results: assets.map((asset) => ({
            assetPath: asset.assetPath ?? '',
            assetType: asset.assetType ?? 'fbx',
            decoderKind: asset.assetType ?? 'fbx',
            preclassification: 'no-signal',
          })),
        });
      },
    });

    const convex = startFakeConvexServer({
      mutation: {
        'couplingForensics:recordLookupAudit': () => null,
      },
    });

    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const apiProcess = new ManagedProcess(['run', START_API_FROM_CWD_PATH], {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(apiPort),
      SITE_URL: apiBaseUrl,
      FRONTEND_URL: 'http://localhost:3000',
      CONVEX_API_SECRET: 'test-convex-api-secret',
      CONVEX_SITE_URL: convex.url,
      CONVEX_URL: convex.url,
      BETTER_AUTH_SECRET: 'test-better-auth-secret',
      INTERNAL_RPC_SHARED_SECRET: TEST_INTERNAL_SECRET,
      YUCP_COUPLING_SERVICE_BASE_URL: `http://127.0.0.1:${couplingPort}`,
      YUCP_COUPLING_SERVICE_SHARED_SECRET: '',
      COUPLING_SERVICE_SECRET: WRONG_LEGACY_COUPLING_SECRET,
      YUCP_TEST_CWD: tempDir,
    });

    try {
      await writeFile(
        path.join(tempDir, '.env.infisical'),
        [
          `INFISICAL_URL=http://127.0.0.1:${infisicalPort}`,
          `INFISICAL_PROJECT_ID=${INFISICAL_PROJECT_ID}`,
          `INFISICAL_CLIENT_ID=${INFISICAL_CLIENT_ID}`,
          `INFISICAL_CLIENT_SECRET=${INFISICAL_CLIENT_SECRET}`,
          'INFISICAL_ENV=dev',
        ].join('\n'),
        'utf8'
      );

      await waitForHealthcheck(apiBaseUrl);
      await apiProcess.waitForOutput(/API server ready/);

      const archiveBytes = zipSync({
        'bundle/model.fbx': strToU8('fake-fbx-content'),
      });
      const archiveBlob = Buffer.from(archiveBytes);

      const formData = new FormData();
      formData.set('packageId', 'creator.package');
      formData.set('file', new File([archiveBlob], 'bundle.zip', { type: 'application/zip' }));

      const response = await fetch(new URL('/api/forensics/lookup', apiBaseUrl), {
        method: 'POST',
        headers: {
          'x-internal-service-secret': TEST_INTERNAL_SECRET,
          'x-yucp-auth-user-id': 'creator-user',
        },
        body: formData,
      });

      const body = (await response.json()) as {
        lookupStatus?: string;
        candidateAssetCount?: number;
        error?: string;
      };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        lookupStatus: 'tampered_suspected',
        candidateAssetCount: 1,
      });
      expect(receivedCouplingAuthorization).toBe(`Bearer ${COUPLING_SHARED_SECRET}`);
      expect(loginRequestCount).toBeGreaterThan(0);
      expect(secretListRequestCount).toBeGreaterThan(0);
    } finally {
      await apiProcess.stop();
      convex.stop();
      couplingServer.stop(true);
      infisicalServer.stop(true);
      await rm(tempDir, { recursive: true, force: true });
    }
  },
  60_000
);
