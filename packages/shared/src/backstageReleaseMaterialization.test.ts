import { describe, expect, it } from 'bun:test';
import { gunzipSync, gzipSync, strToU8, unzipSync, zipSync } from 'fflate';
import { materializeBackstageReleaseArtifact } from './backstageReleaseMaterialization';

const ZIP_DATE_A = new Date(315705600000);
const ZIP_DATE_B = new Date(315964800000);
const TAR_MTIME_A = 123;
const TAR_MTIME_B = 456;

function writeAscii(target: Uint8Array, offset: number, length: number, value: string) {
  const encoded = new TextEncoder().encode(value);
  target.set(encoded.subarray(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  writeAscii(target, offset, length - 1, encoded);
  target[offset + length - 1] = 0;
}

function writeChecksum(target: Uint8Array, value: number) {
  const encoded = value.toString(8).padStart(6, '0');
  writeAscii(target, 148, 6, encoded);
  target[154] = 0;
  target[155] = 0x20;
}

function buildTarHeader(path: string, size: number, mtimeSeconds: number): Uint8Array {
  const header = new Uint8Array(512);
  writeAscii(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtimeSeconds);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeAscii(header, 257, 6, 'ustar');
  writeAscii(header, 263, 2, '00');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeChecksum(header, checksum);
  return header;
}

function buildUnitypackage(
  entries: Array<{ path: string; content: Uint8Array }>,
  mtimeSeconds: number
): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = buildTarHeader(entry.path, entry.content.byteLength, mtimeSeconds);
    blocks.push(header);
    blocks.push(entry.content);
    const remainder = entry.content.byteLength % 512;
    if (remainder !== 0) {
      blocks.push(new Uint8Array(512 - remainder));
    }
  }
  blocks.push(new Uint8Array(1024));

  const totalSize = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const tarBytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const block of blocks) {
    tarBytes.set(block, offset);
    offset += block.byteLength;
  }
  return gzipSync(tarBytes, { level: 9, mtime: mtimeSeconds });
}

function listUnitypackageFiles(input: Uint8Array): Record<string, string> {
  const tarBytes = gunzipSync(input);
  const files: Record<string, string> = {};
  let offset = 0;
  while (offset + 512 <= tarBytes.byteLength) {
    const header = tarBytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((value) => value === 0)) {
      break;
    }
    const rawPath = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/, '').trim();
    const size = Number.parseInt(
      new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim() || '0',
      8
    );
    const fileBytes = tarBytes.slice(offset, offset + size);
    files[rawPath] = new TextDecoder().decode(fileBytes);
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

describe('materializeBackstageReleaseArtifact', () => {
  it('canonicalizes ZIP uploads into deterministic deliverable bytes', async () => {
    const firstInput = zipSync(
      {
        'Packages/com.yucp.example/package.json': [
          strToU8('{"name":"pkg"}'),
          { mtime: ZIP_DATE_A },
        ],
        'Packages/com.yucp.example/README.md': [strToU8('hello'), { mtime: ZIP_DATE_A }],
      },
      { level: 9 }
    );
    const secondInput = zipSync(
      {
        'Packages/com.yucp.example/README.md': [strToU8('hello'), { mtime: ZIP_DATE_B }],
        'Packages/com.yucp.example/package.json': [
          strToU8('{"name":"pkg"}'),
          { mtime: ZIP_DATE_B },
        ],
      },
      { level: 9 }
    );

    const first = await materializeBackstageReleaseArtifact({
      sourceBytes: firstInput,
      deliveryName: 'example.zip',
      contentType: 'application/zip',
    });
    const second = await materializeBackstageReleaseArtifact({
      sourceBytes: secondInput,
      deliveryName: 'example.zip',
      contentType: 'application/zip',
    });

    expect(first.materializationStrategy).toBe('normalized_repack');
    expect(first.bytes).toEqual(second.bytes);
    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes).not.toEqual(firstInput);
    expect(Object.keys(unzipSync(first.bytes)).sort()).toEqual([
      'Packages/com.yucp.example/README.md',
      'Packages/com.yucp.example/package.json',
    ]);
  });

  it('canonicalizes unitypackage uploads into deterministic deliverable bytes', async () => {
    const firstInput = buildUnitypackage(
      [
        { path: 'b-guid/asset', content: strToU8('readme-bytes') },
        { path: 'a-guid/asset', content: strToU8('png-bytes') },
        { path: 'a-guid/pathname', content: strToU8('Assets/Avatar/body.png') },
        { path: 'b-guid/pathname', content: strToU8('Assets/Avatar/readme.txt') },
      ],
      TAR_MTIME_A
    );
    const secondInput = buildUnitypackage(
      [
        { path: 'a-guid/pathname', content: strToU8('Assets/Avatar/body.png') },
        { path: 'a-guid/asset', content: strToU8('png-bytes') },
        { path: 'b-guid/pathname', content: strToU8('Assets/Avatar/readme.txt') },
        { path: 'b-guid/asset', content: strToU8('readme-bytes') },
      ],
      TAR_MTIME_B
    );

    const first = await materializeBackstageReleaseArtifact({
      sourceBytes: firstInput,
      deliveryName: 'example.unitypackage',
      contentType: 'application/octet-stream',
    });
    const second = await materializeBackstageReleaseArtifact({
      sourceBytes: secondInput,
      deliveryName: 'example.unitypackage',
      contentType: 'application/octet-stream',
    });

    expect(first.materializationStrategy).toBe('normalized_repack');
    expect(first.bytes).toEqual(second.bytes);
    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes).not.toEqual(firstInput);
    expect(listUnitypackageFiles(first.bytes)).toEqual({
      'a-guid/asset': 'png-bytes',
      'a-guid/pathname': 'Assets/Avatar/body.png',
      'b-guid/asset': 'readme-bytes',
      'b-guid/pathname': 'Assets/Avatar/readme.txt',
    });
  });

  it('rejects unsafe archive paths during materialization', async () => {
    const input = zipSync(
      {
        '../escape.txt': [strToU8('oops'), { mtime: ZIP_DATE_A }],
      },
      { level: 9 }
    );

    await expect(
      materializeBackstageReleaseArtifact({
        sourceBytes: input,
        deliveryName: 'unsafe.zip',
        contentType: 'application/zip',
      })
    ).rejects.toThrow('unsafe archive path');
  });
});
