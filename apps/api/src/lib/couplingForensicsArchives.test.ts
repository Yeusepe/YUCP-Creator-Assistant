import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { extractCouplingForensicsArchive } from './couplingForensicsArchives';

function createTarEntry(
  name: string,
  body: Uint8Array,
  declaredSize = body.byteLength
): Uint8Array {
  const header = new Uint8Array(512);
  const writeAscii = (offset: number, length: number, value: string) => {
    const encoded = strToU8(value);
    header.set(encoded.slice(0, length), offset);
  };
  const writeOctal = (offset: number, length: number, value: number) => {
    writeAscii(offset, length, value.toString(8).padStart(length - 1, '0'));
  };

  writeAscii(0, 100, name);
  writeOctal(100, 8, 0o644);
  writeOctal(108, 8, 0);
  writeOctal(116, 8, 0);
  writeOctal(124, 12, declaredSize);
  writeOctal(136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeAscii(257, 6, 'ustar');
  writeAscii(263, 2, '00');

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeAscii(148, 8, checksum.toString(8).padStart(6, '0'));
  header[154] = 0;
  header[155] = 0x20;

  const paddedSize = Math.ceil(body.byteLength / 512) * 512;
  const entry = new Uint8Array(512 + paddedSize);
  entry.set(header);
  entry.set(body, 512);
  return entry;
}

function buildGzippedTar(entries: Uint8Array[]): Uint8Array {
  const end = new Uint8Array(1024);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.byteLength, end.byteLength);
  const tarBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const entry of entries) {
    tarBytes.set(entry, offset);
    offset += entry.byteLength;
  }
  tarBytes.set(end, offset);
  return gzipSync(tarBytes);
}

function rewriteZipDeclaredUncompressedSize(bytes: Uint8Array, declaredSize: number): Uint8Array {
  const rewritten = new Uint8Array(bytes);
  const view = new DataView(rewritten.buffer, rewritten.byteOffset, rewritten.byteLength);
  for (let index = 0; index < rewritten.byteLength - 4; index += 1) {
    const signature = view.getUint32(index, true);
    if (signature === 0x04034b50) {
      view.setUint32(index + 22, declaredSize, true);
    }
    if (signature === 0x02014b50) {
      view.setUint32(index + 24, declaredSize, true);
    }
  }
  return rewritten;
}

async function writeArchive(workspaceDir: string, name: string, bytes: Uint8Array) {
  const archivePath = path.join(workspaceDir, name);
  await writeFile(archivePath, bytes);
  return archivePath;
}

describe('coupling forensics archive extraction limits', () => {
  let workspaceDir: string | null = null;

  afterEach(async () => {
    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
    }
  });

  it('rejects zip entries that exceed the extracted entry budget', async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'yucp-forensics-zip-test-'));
    const archivePath = await writeArchive(
      workspaceDir,
      'bundle.zip',
      zipSync({
        'Assets/Character/body.png': new Uint8Array([1, 2]),
      })
    );

    await expect(
      extractCouplingForensicsArchive(archivePath, 'bundle.zip', workspaceDir, {
        maxExtractedEntryBytes: 1,
      })
    ).rejects.toThrow('Archive entry exceeds the extracted size limit');
  });

  it('rejects stored zip entries whose declared size understates extracted bytes', async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'yucp-forensics-zip-understated-test-'));
    const archivePath = await writeArchive(
      workspaceDir,
      'bundle.zip',
      rewriteZipDeclaredUncompressedSize(
        zipSync(
          {
            'Assets/Character/body.png': new Uint8Array(100),
          },
          { level: 0 }
        ),
        1
      )
    );

    await expect(
      extractCouplingForensicsArchive(archivePath, 'bundle.zip', workspaceDir, {
        maxExtractedEntryBytes: 50,
      })
    ).rejects.toThrow('Archive entry exceeds the extracted size limit');
  });

  it('rejects zip archives that exceed the total extracted budget', async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'yucp-forensics-zip-total-test-'));
    const archivePath = await writeArchive(
      workspaceDir,
      'bundle.zip',
      zipSync({
        'Assets/Character/body.png': new Uint8Array(50),
        'Assets/Character/hair.png': new Uint8Array(50),
        'Assets/Character/outfit.png': new Uint8Array(50),
      })
    );

    await expect(
      extractCouplingForensicsArchive(archivePath, 'bundle.zip', workspaceDir, {
        maxExtractedEntryBytes: 100,
        maxExtractedTotalBytes: 100,
      })
    ).rejects.toThrow('Archive exceeds the extracted size limit');
  });

  it('rejects unitypackage entries that exceed the extracted entry budget', async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'yucp-forensics-unity-test-'));
    await mkdir(path.join(workspaceDir, 'fixtures'), { recursive: true });
    const archivePath = await writeArchive(
      workspaceDir,
      'bundle.unitypackage',
      buildGzippedTar([
        createTarEntry('asset/pathname', strToU8('Assets/Character/body.png')),
        createTarEntry('asset/asset', new Uint8Array([1, 2])),
      ])
    );

    await expect(
      extractCouplingForensicsArchive(archivePath, 'bundle.unitypackage', workspaceDir, {
        maxExtractedEntryBytes: 1,
      })
    ).rejects.toThrow('Archive entry exceeds the extracted size limit');
  });

  it('rejects unitypackage archives that exceed the total extracted budget', async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'yucp-forensics-unity-total-test-'));
    const archivePath = await writeArchive(
      workspaceDir,
      'bundle.unitypackage',
      buildGzippedTar([
        createTarEntry('asset-a/pathname', strToU8('Assets/Character/body.png')),
        createTarEntry('asset-a/asset', new Uint8Array(50)),
        createTarEntry('asset-b/pathname', strToU8('Assets/Character/hair.png')),
        createTarEntry('asset-b/asset', new Uint8Array(50)),
        createTarEntry('asset-c/pathname', strToU8('Assets/Character/outfit.png')),
        createTarEntry('asset-c/asset', new Uint8Array(50)),
      ])
    );

    await expect(
      extractCouplingForensicsArchive(archivePath, 'bundle.unitypackage', workspaceDir, {
        maxExtractedEntryBytes: 100,
        maxExtractedTotalBytes: 100,
      })
    ).rejects.toThrow('Archive exceeds the extracted size limit');
  });
});
