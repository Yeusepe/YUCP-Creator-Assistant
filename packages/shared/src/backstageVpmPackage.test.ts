import { describe, expect, it } from 'bun:test';
import { strFromU8, unzipSync } from 'fflate';
import {
  type PreparedBackstageArtifact,
  prepareBackstageArtifactForPublish,
} from './backstageVpmPackage';

function readZipTextFile(artifact: PreparedBackstageArtifact, path: string): string {
  const files = unzipSync(artifact.bytes);
  const file = files[path];
  expect(file).toBeDefined();
  return strFromU8(file);
}

describe('prepareBackstageArtifactForPublish', () => {
  it('wraps unitypackage uploads into VPM ZIP artifacts', async () => {
    const artifact = await prepareBackstageArtifactForPublish({
      packageId: 'com.yucp.example',
      version: '1.2.3',
      displayName: 'Example Package',
      description: 'Example description',
      unityVersion: '2022.3',
      metadata: {
        dependencies: {
          'com.vrchat.base': '3.7.0',
        },
      },
      sourceBytes: new Uint8Array([1, 2, 3, 4]),
      sourceFileName: 'example.unitypackage',
    });

    expect(artifact.sourceKind).toBe('unitypackage');
    expect(artifact.contentType).toBe('application/zip');
    expect(artifact.deliveryName).toBe('com.yucp.example-1.2.3.zip');
    expect(artifact.zipSha256).toMatch(/^[a-f0-9]{64}$/);

    const packageJson = JSON.parse(readZipTextFile(artifact, 'package.json')) as {
      name: string;
      version: string;
      displayName: string;
      description: string;
      unity: string;
      dependencies: Record<string, string>;
    };
    expect(packageJson).toEqual({
      name: 'com.yucp.example',
      version: '1.2.3',
      displayName: 'Example Package',
      description: 'Example description',
      unity: '2022.3',
      dependencies: {
        'com.vrchat.base': '3.7.0',
      },
    });

    const installerManifest = JSON.parse(
      readZipTextFile(artifact, 'BackstagePayload~/backstage-payload.json')
    ) as {
      packageId: string;
      version: string;
      payloadFileName: string;
      payloadSha256: string;
    };
    expect(installerManifest.packageId).toBe('com.yucp.example');
    expect(installerManifest.version).toBe('1.2.3');
    expect(installerManifest.payloadFileName).toBe('example.unitypackage');
    expect(installerManifest.payloadSha256).toMatch(/^[a-f0-9]{64}$/);

    const files = unzipSync(artifact.bytes);
    expect(files['BackstagePayload~/payload.unitypackage']).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(strFromU8(files['Editor/Yucp.Backstage.PackageInstaller.asmdef'])).toContain(
      'Yucp.Backstage.PackageInstaller.'
    );
    const installerScript = strFromU8(
      files['Editor/YucpBackstageEmbeddedUnitypackageInstaller.cs']
    );
    expect(installerScript).toContain('AssetDatabase.ImportPackage');
    expect(installerScript).toContain('UnityEditor.PackageManager.PackageInfo.FindForAssembly');
    expect(installerScript).toContain('UnityEngine.JsonUtility.FromJson<BackstagePayloadManifest>');
  });

  it('passes ZIP uploads through unchanged', async () => {
    const artifact = await prepareBackstageArtifactForPublish({
      packageId: 'com.yucp.example',
      version: '1.2.3',
      sourceBytes: new Uint8Array([80, 75, 3, 4]),
      sourceFileName: 'example.zip',
    });

    expect(artifact.sourceKind).toBe('zip');
    expect(artifact.contentType).toBe('application/zip');
    expect(artifact.deliveryName).toBe('example.zip');
    expect(artifact.bytes).toEqual(new Uint8Array([80, 75, 3, 4]));
  });
});
