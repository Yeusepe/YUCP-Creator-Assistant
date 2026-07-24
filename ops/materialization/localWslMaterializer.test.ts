import { describe, expect, test } from 'bun:test';
import {
  buildLocalMaterializerBridgeRoutes,
  buildMasterCredentialArguments,
  buildPreparationArguments,
  buildWslEnvironment,
  parseWslNetworkProbe,
  requireLoopbackEndpointPort,
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
    expect(env.MATERIALIZATION_MASTER_EPOCH_KEYS_FILE).toBe(
      '/home/yucp/.config/yucp-materializer/materialization-master-epochs'
    );
    expect(env.MATERIALIZATION_MASTER_EPOCH_KEYS).toBeUndefined();
    expect(env.MATERIALIZATION_POLL_INTERVAL_MS).toBe('1000');
    expect(env.YUCP_MINIO_PORT).toBeUndefined();
    expect(env.WSLENV).not.toContain('YUCP_MINIO_PORT');
    expect(env.WSLENV).toContain('MATERIALIZATION_DPOP_PRIVATE_KEY_PKCS8');
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

  test('runs preparation and credential writes from Linux script files', () => {
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
    expect(buildMasterCredentialArguments('YUCP-Materializer')).toEqual([
      '-d',
      'YUCP-Materializer',
      '--',
      '/bin/bash',
      '/home/yucp/ca-coupling/deploy/write-local-master-credential.sh',
    ]);
  });
});
