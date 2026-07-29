import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildWranglerDeployWithSecretsArgs,
  createTemporaryDeliveryWorkerDeployArtifacts,
} from './cloudflare-web-config';

describe('delivery Worker deployment', () => {
  test('replaces placeholder vars with encrypted bindings in the same upload', () => {
    const artifacts = createTemporaryDeliveryWorkerDeployArtifacts({
      COMMON_S3_ENDPOINT: 'https://storage.example.test',
      PACKAGE_INSTALL_SIGNING_KEY_ID: 'test-key-id',
    });

    try {
      const config = JSON.parse(readFileSync(artifacts.configPath, 'utf8')) as {
        main?: string;
        vars?: Record<string, string>;
        secrets?: { required?: string[] };
      };
      const secrets = JSON.parse(readFileSync(artifacts.secretsPath, 'utf8')) as Record<
        string,
        string
      >;

      expect(config.main).toBe(
        resolve(process.cwd(), 'services', 'delivery-worker', 'src', 'index.ts')
      );
      expect(config.vars).toBeUndefined();
      expect(config.secrets?.required).toEqual([
        'COMMON_S3_ENDPOINT',
        'PACKAGE_INSTALL_SIGNING_KEY_ID',
      ]);
      expect(secrets).toEqual({
        COMMON_S3_ENDPOINT: 'https://storage.example.test',
        PACKAGE_INSTALL_SIGNING_KEY_ID: 'test-key-id',
      });
      expect(
        buildWranglerDeployWithSecretsArgs(artifacts.configPath, artifacts.secretsPath)
      ).toEqual([
        'deploy',
        '--config',
        artifacts.configPath,
        '--secrets-file',
        artifacts.secretsPath,
      ]);
    } finally {
      artifacts.cleanup();
    }
  });
});
