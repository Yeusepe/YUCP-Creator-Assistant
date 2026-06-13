import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildCdngineComposeArgs,
  buildCdngineDockerImageArgs,
  buildCdngineRemoteComposeUrl,
  buildCdngineComposeFilePath,
  isCdnginePublicRuntimeReady,
  monitorExistingCdnginePublicRuntime,
  prepareDockerCompose,
  renderCdngineCompose,
  resolveCdngineDevConfig,
} from './cdngine-dev';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

describe('cdngine docker dev runner', () => {
  test('resolveCdngineDevConfig reads the Docker ref without a source checkout path', () => {
    expect(
      resolveCdngineDevConfig({
        CDNGINE_DOCKER_REF: 'ef5813602b76c996e907261ee9afc4f45722c596',
      })
    ).toEqual({
      composeDir: path.join(process.cwd(), '.volumes', 'cdngine', 'docker'),
      projectName: 'yucp-cdngine-dev',
      ref: 'ef5813602b76c996e907261ee9afc4f45722c596',
      startMode: 'server',
    });
  });

  test('buildCdngineRemoteComposeUrl points at the no-checkout compose file for the requested ref', () => {
    expect(buildCdngineRemoteComposeUrl('ef5813602b76c996e907261ee9afc4f45722c596')).toBe(
      'https://raw.githubusercontent.com/Yeusepe/cdngine/ef5813602b76c996e907261ee9afc4f45722c596/deploy/remote/compose.latest.yaml'
    );
  });

  test('buildCdngineComposeFilePath sanitizes branch refs for local filenames', () => {
    expect(buildCdngineComposeFilePath('E:\\tmp\\cdngine', 'feature/runtime/dev')).toBe(
      path.join('E:\\tmp\\cdngine', 'compose.feature_runtime_dev.yaml')
    );
  });

  test('renderCdngineCompose removes the Compose build block after the image is built from GitHub', () => {
    const rendered = renderCdngineCompose(
      [
        'services:',
        '  cdngine-runtime:',
        '    build:',
        '      context: https://github.com/Yeusepe/cdngine.git#main',
        '      dockerfile: Dockerfile',
        '    image: cdngine-latest-instance:latest',
        '    command: ["npm", "run", "runtime:start", "--workspace", "@cdngine/demo"]',
      ].join('\n')
    );

    expect(rendered).not.toContain('build:');
    expect(rendered).not.toContain('context:');
    expect(rendered).toContain('image: cdngine-latest-instance:latest');
  });

  test('prepareDockerCompose times out remote compose fetches and writes sanitized ref filenames', async () => {
    const composeDir = await mkdtemp(path.join(os.tmpdir(), 'yucp-cdngine-compose-'));
    let fetchInit: RequestInit | undefined;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchInit = init;
      return new Response(
        [
          'services:',
          '  cdngine-runtime:',
          '    build:',
          '      context: https://github.com/Yeusepe/cdngine.git#feature/runtime/dev',
          '      dockerfile: Dockerfile',
          '    image: cdngine-latest-instance:latest',
        ].join('\n'),
        { status: 200 }
      );
    };

    const prepared = await prepareDockerCompose(
      {
        composeDir,
        projectName: 'yucp-cdngine-dev',
        ref: 'feature/runtime/dev',
        startMode: 'server',
      },
      {},
      fetchImpl
    );

    expect(fetchInit?.signal).toBeInstanceOf(AbortSignal);
    expect(prepared.composeFilePath).toBe(
      path.join(composeDir, 'compose.feature_runtime_dev.yaml')
    );
    await expect(readFile(prepared.composeFilePath, 'utf8')).resolves.toContain(
      'image: cdngine-latest-instance:latest'
    );
  });

  test('buildCdngineDockerImageArgs builds the runtime image from the GitHub ref', () => {
    expect(buildCdngineDockerImageArgs('ef5813602b76c996e907261ee9afc4f45722c596')).toEqual([
      'buildx',
      'build',
      '--load',
      '-t',
      'cdngine-latest-instance:latest',
      'https://github.com/Yeusepe/cdngine.git#ef5813602b76c996e907261ee9afc4f45722c596',
    ]);
  });

  test('buildCdngineComposeArgs starts the docker runtime instance through Compose', () => {
    expect(
      buildCdngineComposeArgs({
        composeFilePath: 'E:\\tmp\\compose.yaml',
        envFilePath: 'E:\\tmp\\cdngine.env',
        projectName: 'yucp-cdngine-dev',
        startMode: 'server',
      })
    ).toEqual([
      'compose',
      '--project-name',
      'yucp-cdngine-dev',
      '--env-file',
      'E:\\tmp\\cdngine.env',
      '-f',
      'E:\\tmp\\compose.yaml',
      'up',
      '-d',
      'cdngine-runtime',
    ]);
  });

  test('buildCdngineComposeArgs can include the demo profile explicitly', () => {
    expect(
      buildCdngineComposeArgs({
        composeFilePath: 'E:\\tmp\\compose.yaml',
        envFilePath: 'E:\\tmp\\cdngine.env',
        projectName: 'yucp-cdngine-dev',
        startMode: 'demo',
      })
    ).toEqual([
      'compose',
      '--project-name',
      'yucp-cdngine-dev',
      '--env-file',
      'E:\\tmp\\cdngine.env',
      '-f',
      'E:\\tmp\\compose.yaml',
      '--profile',
      'demo',
      'up',
      '-d',
      'cdngine-runtime',
      'cdngine-demo',
    ]);
  });

  test('isCdnginePublicRuntimeReady requires the real CDNgine health contract', async () => {
    const requests: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push(String(url));
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (String(url) === 'http://localhost:4000/uploads/yucp-readiness-probe') {
        expect(init?.method).toBe('HEAD');
        return new Response(null, {
          status: 404,
          headers: {
            'access-control-allow-origin': 'http://localhost:3000',
          },
        });
      }
      return jsonResponse({
        service: '@cdngine/api',
        status: 'ok',
      });
    };

    await expect(isCdnginePublicRuntimeReady('http://localhost:4000', fetchImpl)).resolves.toBe(
      true
    );
    expect(requests).toEqual([
      'http://localhost:4000/healthz',
      'http://localhost:4000/uploads/yucp-readiness-probe',
    ]);
  });

  test('isCdnginePublicRuntimeReady rejects a generic successful response', async () => {
    const fetchImpl = async (): Promise<Response> =>
      jsonResponse({
        service: 'not-cdngine',
        status: 'ok',
      });

    await expect(isCdnginePublicRuntimeReady('http://localhost:4000', fetchImpl)).resolves.toBe(
      false
    );
  });

  test('isCdnginePublicRuntimeReady requires the upload target dependencies to respond', async () => {
    const requests: string[] = [];
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      requests.push(String(url));
      if (String(url) === 'http://localhost:4000/healthz') {
        return jsonResponse({
          service: '@cdngine/api',
          status: 'ok',
        });
      }

      return new Response(null, {
        status: 503,
        headers: {
          'access-control-allow-origin': 'http://localhost:3000',
        },
      });
    };

    await expect(isCdnginePublicRuntimeReady('http://localhost:4000', fetchImpl)).resolves.toBe(
      false
    );
    expect(requests).toContain('http://localhost:4000/uploads/yucp-readiness-probe');
  });

  test('monitorExistingCdnginePublicRuntime fails when the reused runtime stops responding', async () => {
    let healthAttempt = 0;
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      if (String(url) === 'http://localhost:4000/uploads/yucp-readiness-probe') {
        return new Response(null, {
          status: 404,
          headers: {
            'access-control-allow-origin': 'http://localhost:3000',
          },
        });
      }

      healthAttempt += 1;
      return healthAttempt === 1
        ? jsonResponse({
            service: '@cdngine/api',
            status: 'ok',
          })
        : jsonResponse(
            {
              service: '@cdngine/api',
              status: 'offline',
            },
            503
          );
    };

    await expect(
      monitorExistingCdnginePublicRuntime('http://localhost:4000', 1, fetchImpl)
    ).rejects.toThrow('Existing CDNgine public runtime at http://localhost:4000 stopped responding');
  });
});
