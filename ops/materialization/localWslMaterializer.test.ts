import { describe, expect, test } from 'bun:test';
import {
  buildLocalMaterializerBridgeRoutes,
  buildPreparationArguments,
  buildWslEnvironment,
  parseWslNetworkProbe,
  requireLoopbackEndpointPort,
  waitForLocalMaterializerDependencies,
  windowsPathToWslPath,
} from './localWslMaterializer';

describe('local WSL materializer orchestration', () => {
  test('uses narrow bidirectional routes without changing signed loopback URLs', () => {
    expect(
      buildLocalMaterializerBridgeRoutes({
        windowsHostIp: '172.24.0.1',
        wslIp: '172.24.8.9',
      })
    ).toEqual([
      {
        listenHost: '172.24.0.1',
        listenPort: 3_005,
        targetHost: '127.0.0.1',
        targetPort: 3_005,
      },
      {
        listenHost: '172.24.0.1',
        listenPort: 3_012,
        targetHost: '127.0.0.1',
        targetPort: 3_012,
      },
      {
        listenHost: '127.0.0.1',
        listenPort: 8_788,
        targetHost: '172.24.8.9',
        targetPort: 8_788,
      },
    ]);
  });

  test('uses the reserved lifecycle ports for every WSL bridge', () => {
    expect(
      buildLocalMaterializerBridgeRoutes({
        controlPort: 41_012,
        healthPort: 41_008,
        sourcePort: 41_005,
        windowsHostIp: '172.24.0.1',
        wslIp: '172.24.8.9',
      })
    ).toEqual([
      {
        listenHost: '172.24.0.1',
        listenPort: 41_005,
        targetHost: '127.0.0.1',
        targetPort: 41_005,
      },
      {
        listenHost: '172.24.0.1',
        listenPort: 41_012,
        targetHost: '127.0.0.1',
        targetPort: 41_012,
      },
      {
        listenHost: '127.0.0.1',
        listenPort: 41_008,
        targetHost: '172.24.8.9',
        targetPort: 41_008,
      },
    ]);
  });

  test('passes no master epoch key through the process environment', () => {
    const env = buildWslEnvironment({
      baseEnv: {
        MATERIALIZATION_KEY_BROKER_SHARED_SECRET: 'broker-secret-with-24-bytes',
        MATERIALIZATION_MATERIALIZER_SHARED_SECRET: 'materializer-secret-with-24-bytes',
        YUCP_COUPLING_SERVICE_SHARED_SECRET: 'coupling-secret-with-24-bytes',
      },
      dpopPrivateKey: 'private-key',
      windowsHostIp: '172.24.0.1',
    });
    expect(env.MATERIALIZATION_CONTROL_PLANE_BASE_URL).toBe('http://127.0.0.1:3012');
    expect(env.MATERIALIZATION_KEY_EPOCH).toBe('1');
    expect(env.MATERIALIZATION_CHUNK_CACHE_MAX_BYTES).toBe('4294967296');
    expect(env.MATERIALIZATION_EMERGENCY_DISK_FLOOR_BYTES).toBe(
      '13958643712'
    );
    expect(env.MATERIALIZATION_POLL_INTERVAL_MS).toBe('1000');
    expect(env.YUCP_MINIO_PORT).toBeUndefined();
    expect(env.WSLENV).not.toContain('YUCP_MINIO_PORT');
    expect(env.WSLENV).toContain('MATERIALIZATION_DPOP_PRIVATE_KEY_PKCS8');
    expect(env.WSLENV).toContain('MATERIALIZATION_CHUNK_CACHE_MAX_BYTES');
    expect(env.WSLENV).toContain(
      'MATERIALIZATION_EMERGENCY_DISK_FLOOR_BYTES'
    );
  });

  test('isolates each disposable worker and forwards its dynamic source endpoint', () => {
    const env = buildWslEnvironment({
      baseEnv: {
        MATERIALIZATION_CONTROL_PLANE_BASE_URL: 'http://127.0.0.1:49120',
        MATERIALIZATION_KEY_BROKER_SHARED_SECRET: 'k'.repeat(32),
        MATERIALIZATION_MATERIALIZER_SHARED_SECRET: 'm'.repeat(32),
        MATERIALIZATION_SOURCE_BASE_URL: 'http://127.0.0.1:49121',
        YUCP_COUPLING_SERVICE_SHARED_SECRET: 'c'.repeat(32),
        YUCP_DISPOSABLE_RUN_ID: '0123456789ab',
      },
      dpopPrivateKey: 'private-dpop',
      windowsHostIp: '172.30.16.1',
    });

    expect(env.MATERIALIZATION_SERVICE_ID).toBe('local-materializer-large-0123456789ab');
    expect(env.MATERIALIZATION_WORK_ROOT).toBe(
      '/home/yucp/.local/share/yucp-materializer/0123456789ab'
    );
    expect(env.MATERIALIZATION_SOURCE_BASE_URL).toBe('http://127.0.0.1:49121');
    expect(env.MATERIALIZATION_SOURCE_PROXY_PORT).toBe('49121');
    expect(env.MATERIALIZATION_CONTROL_PLANE_PROXY_PORT).toBe('49120');
    expect(env.WSLENV).toContain('MATERIALIZATION_SOURCE_BASE_URL');
    expect(env.WSLENV).toContain('MATERIALIZATION_SOURCE_PROXY_PORT');
  });

  test('accepts only loopback HTTP storage endpoints', () => {
    expect(requireLoopbackEndpointPort('http://127.0.0.1:49152')).toBe(49_152);
    expect(() => requireLoopbackEndpointPort('http://192.0.2.1:49152')).toThrow('loopback HTTP');
  });

  test('selects the WSL default gateway and primary interface address', () => {
    expect(
      parseWslNetworkProbe(
        'default via 172.17.240.1 dev eth0 proto kernel\n' + '172.17.248.126 172.18.0.1\n'
      )
    ).toEqual({
      windowsHostIp: '172.17.240.1',
      wslIp: '172.17.248.126',
    });
  });

  test('converts the proprietary repository path without shell parsing', () => {
    expect(windowsPathToWslPath('E:\\GitDevelopment\\Development\\ca-coupling')).toBe(
      '/mnt/e/GitDevelopment/Development/ca-coupling'
    );
  });

  test('runs private service preparation from a Linux script file', () => {
    expect(
      buildPreparationArguments(
        'YUCP-Materializer',
        '/mnt/e/GitDevelopment/Development/ca-coupling'
      )
    ).toEqual([
      '-d',
      'YUCP-Materializer',
      '--',
      '/bin/bash',
      '/mnt/e/GitDevelopment/Development/ca-coupling/deploy/prepare-local-wsl-materializer.sh',
      '/mnt/e/GitDevelopment/Development/ca-coupling',
    ]);
  });

  test('waits for Windows control and source listeners before starting WSL proxies', async () => {
    const attempts = new Map<string, number>();
    await waitForLocalMaterializerDependencies({
      fetchImplementation: async (input) => {
        const url = String(input);
        const attempt = (attempts.get(url) ?? 0) + 1;
        attempts.set(url, attempt);
        if (attempt === 1) {
          throw new Error('listener is not ready');
        }
        return new Response('ready', { status: 404 });
      },
      retryIntervalMs: 1,
      timeoutMs: 1_000,
    });

    expect(attempts.get('http://127.0.0.1:3005/')).toBe(2);
    expect(attempts.get('http://127.0.0.1:3012/')).toBe(2);
  });
});
