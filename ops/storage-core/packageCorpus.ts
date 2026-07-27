import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { gzipSync, type Zippable, zipSync } from 'fflate';

const FIXED_MTIME = new Date('2024-01-01T00:00:00.000Z');
const TAR_BLOCK_BYTES = 512;

export type PackageCorpusArchive = {
  bytes: number;
  fileName: string;
  format: 'spp' | 'unitypackage' | 'zip';
  product: string;
  sha256: string;
  version: string;
};

export type PackageCorpusManifest = {
  archives: PackageCorpusArchive[];
  schemaVersion: 1;
  smallFileSizesKiB: number[];
};

type LogicalFiles = Map<string, Uint8Array>;

function requireLogicalFile(files: LogicalFiles, path: string): Uint8Array {
  const bytes = files.get(path);
  if (!bytes) {
    throw new Error(`Representative package corpus is missing a logical file: ${path}`);
  }
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function deterministicBytes(label: string, size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  let counter = 0;
  while (offset < output.length) {
    const block = createHash('sha256').update(`${label}:${counter}`).digest();
    const remaining = output.length - offset;
    output.set(block.subarray(0, Math.min(block.length, remaining)), offset);
    offset += Math.min(block.length, remaining);
    counter += 1;
  }
  return output;
}

function replaceRange(source: Uint8Array, offset: number, replacement: Uint8Array): Uint8Array {
  const output = source.slice();
  output.set(replacement, offset);
  return output;
}

function insertRange(source: Uint8Array, offset: number, inserted: Uint8Array): Uint8Array {
  const output = new Uint8Array(source.length + inserted.length);
  output.set(source.subarray(0, offset), 0);
  output.set(inserted, offset);
  output.set(source.subarray(offset), offset + inserted.length);
  return output;
}

function alphaVersions(): LogicalFiles[] {
  const sharedLarge = deterministicBytes('alpha-large', 2 * 1024 * 1024);
  const versionOne: LogicalFiles = new Map([
    ['Assets/Alpha/Small/one.shader', deterministicBytes('small-1', 1 * 1024)],
    ['Assets/Alpha/Small/four.shader', deterministicBytes('small-4', 4 * 1024)],
    ['Assets/Alpha/Small/sixteen.shader', deterministicBytes('small-16', 16 * 1024)],
    ['Assets/Alpha/Small/thirty-two.shader', deterministicBytes('small-32', 32 * 1024)],
    ['Assets/Alpha/Small/sixty-four.shader', deterministicBytes('small-64', 64 * 1024)],
    ['Assets/Alpha/Large/payload.bin', sharedLarge],
    ['Assets/Alpha/Editor/Install.cs', new TextEncoder().encode('class InstallV1 {}\n')],
  ]);
  const shifted = insertRange(
    replaceRange(sharedLarge, 768 * 1024, deterministicBytes('alpha-local-change', 32 * 1024)),
    512 * 1024,
    deterministicBytes('alpha-insert', 4 * 1024)
  );
  const versionTwo: LogicalFiles = new Map([
    [
      'Assets/Alpha/Small/one.shader',
      requireLogicalFile(versionOne, 'Assets/Alpha/Small/one.shader'),
    ],
    [
      'Assets/Alpha/Small/four.shader',
      requireLogicalFile(versionOne, 'Assets/Alpha/Small/four.shader'),
    ],
    [
      'Assets/Alpha/Renamed/sixteen.shader',
      requireLogicalFile(versionOne, 'Assets/Alpha/Small/sixteen.shader'),
    ],
    [
      'Assets/Alpha/Small/thirty-two.shader',
      requireLogicalFile(versionOne, 'Assets/Alpha/Small/thirty-two.shader'),
    ],
    [
      'Assets/Alpha/Small/sixty-four.shader',
      requireLogicalFile(versionOne, 'Assets/Alpha/Small/sixty-four.shader'),
    ],
    ['Assets/Alpha/Large/payload.bin', shifted],
    ['Assets/Alpha/Editor/Install.cs', new TextEncoder().encode('class InstallV2 {}\n')],
  ]);
  return [versionOne, versionTwo];
}

function betaVersions(sharedShader: Uint8Array): LogicalFiles[] {
  const large = deterministicBytes('beta-large', 1024 * 1024);
  return [
    new Map([
      ['Assets/Beta/Shared/sixty-four.shader', sharedShader],
      ['Assets/Beta/Large/data.bin', large],
      ['Assets/Beta/README.txt', new TextEncoder().encode('Beta version one\n')],
    ]),
    new Map([
      ['Assets/Beta/Renamed/sixty-four.shader', sharedShader],
      [
        'Assets/Beta/Large/data.bin',
        replaceRange(large, 384 * 1024, deterministicBytes('beta-local-change', 16 * 1024)),
      ],
      ['Assets/Beta/README.txt', new TextEncoder().encode('Beta version two\n')],
    ]),
  ];
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length > length) {
    throw new Error(`TAR value exceeds ${length} bytes: ${value}`);
  }
  target.set(encoded, offset);
}

function writeTarOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  writeAscii(target, offset, length, `${encoded}\0`);
}

function tarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_BYTES);
  writeAscii(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor(FIXED_MTIME.getTime() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeAscii(header, 257, 6, 'ustar\0');
  writeAscii(header, 263, 2, '00');
  const checksum = header.reduce((total, value) => total + value, 0);
  const checksumText = checksum.toString(8).padStart(6, '0');
  writeAscii(header, 148, 8, `${checksumText}\0 `);
  return header;
}

function buildTar(entries: Array<{ bytes: Uint8Array; name: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  let totalBytes = TAR_BLOCK_BYTES * 2;
  for (const entry of entries) {
    const padding = (TAR_BLOCK_BYTES - (entry.bytes.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    blocks.push(tarHeader(entry.name, entry.bytes.length), entry.bytes, new Uint8Array(padding));
    totalBytes += TAR_BLOCK_BYTES + entry.bytes.length + padding;
  }
  blocks.push(new Uint8Array(TAR_BLOCK_BYTES * 2));
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const block of blocks) {
    output.set(block, offset);
    offset += block.length;
  }
  return output;
}

function unityMetaBytes(path: string): Uint8Array {
  const guid = createHash('sha256').update(path).digest('hex').slice(0, 32);
  return new TextEncoder().encode(`fileFormatVersion: 2\nguid: ${guid}\n`);
}

function unityPackageBytes(files: LogicalFiles, reverseOrder: boolean): Uint8Array {
  const logicalEntries = [...files.entries()];
  if (reverseOrder) {
    logicalEntries.reverse();
  }
  const tarEntries: Array<{ bytes: Uint8Array; name: string }> = [];
  for (const [path, bytes] of logicalEntries) {
    const guid = createHash('sha256').update(path).digest('hex').slice(0, 32);
    tarEntries.push(
      { bytes, name: `${guid}/asset` },
      { bytes: unityMetaBytes(path), name: `${guid}/asset.meta` },
      { bytes: new TextEncoder().encode(path), name: `${guid}/pathname` }
    );
  }
  return gzipSync(buildTar(tarEntries), { level: 6, mtime: 0 });
}

function zipBytes(files: LogicalFiles, reverseOrder: boolean): Uint8Array {
  const entries: Zippable = {};
  const logicalEntries = [...files.entries()];
  if (reverseOrder) {
    logicalEntries.reverse();
  }
  for (const [path, bytes] of logicalEntries) {
    entries[path] = [bytes, { level: 0, mtime: FIXED_MTIME }];
    entries[`${path}.meta`] = [unityMetaBytes(path), { level: 0, mtime: FIXED_MTIME }];
  }
  return zipSync(entries, { level: 0 });
}

function sppVersions(product: string, sourceBytes: Uint8Array): Uint8Array[] {
  const prefix = deterministicBytes(`${product}-spp-prefix`, 512 * 1024);
  const suffix = deterministicBytes(`${product}-spp-suffix`, 512 * 1024);
  const first = new Uint8Array(prefix.length + sourceBytes.length + suffix.length);
  first.set(prefix, 0);
  first.set(sourceBytes, prefix.length);
  first.set(suffix, prefix.length + sourceBytes.length);
  return [
    first,
    insertRange(
      replaceRange(first, 640 * 1024, deterministicBytes(`${product}-spp-change`, 32 * 1024)),
      768 * 1024,
      deterministicBytes(`${product}-spp-insert`, 4 * 1024)
    ),
  ];
}

async function writeArchive(
  outputPath: string,
  input: Omit<PackageCorpusArchive, 'bytes' | 'fileName' | 'sha256'> & {
    bytes: Uint8Array;
    fileName: string;
  }
): Promise<PackageCorpusArchive> {
  const filePath = join(outputPath, input.fileName);
  await writeFile(filePath, input.bytes);
  return {
    bytes: input.bytes.length,
    fileName: basename(filePath),
    format: input.format,
    product: input.product,
    sha256: sha256(input.bytes),
    version: input.version,
  };
}

export async function buildRepresentativePackageCorpus(
  outputPath: string
): Promise<PackageCorpusManifest> {
  const root = resolve(outputPath);
  await mkdir(root, { recursive: true });
  const alpha = alphaVersions();
  const beta = betaVersions(requireLogicalFile(alpha[0], 'Assets/Alpha/Small/sixty-four.shader'));
  const products = new Map([
    ['alpha', alpha],
    ['beta', beta],
  ]);
  const archives: PackageCorpusArchive[] = [];

  for (const [product, versions] of products) {
    for (const [versionIndex, files] of versions.entries()) {
      const suffix = versionIndex === 0 ? '' : ` (${versionIndex})`;
      archives.push(
        await writeArchive(root, {
          bytes: unityPackageBytes(files, versionIndex % 2 === 1),
          fileName: `${product}${suffix}.unitypackage`,
          format: 'unitypackage',
          product,
          version: `${versionIndex + 1}.0.0`,
        }),
        await writeArchive(root, {
          bytes: zipBytes(files, versionIndex % 2 === 1),
          fileName: `${product}${suffix}.zip`,
          format: 'zip',
          product,
          version: `${versionIndex + 1}.0.0`,
        })
      );
    }

    const spp = sppVersions(product, deterministicBytes(`${product}-spp-body`, 2 * 1024 * 1024));
    for (const [versionIndex, bytes] of spp.entries()) {
      archives.push(
        await writeArchive(root, {
          bytes,
          fileName:
            versionIndex === 0 ? `${product}.spp` : `${product}_autosave_${versionIndex}.spp`,
          format: 'spp',
          product,
          version: `${versionIndex + 1}.0.0`,
        })
      );
    }
  }

  const manifest: PackageCorpusManifest = {
    archives: archives.sort((left, right) => left.fileName.localeCompare(right.fileName)),
    schemaVersion: 1,
    smallFileSizesKiB: [1, 4, 16, 32, 64],
  };
  await writeFile(join(root, 'corpus-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
