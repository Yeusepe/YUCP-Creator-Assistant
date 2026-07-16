import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { runCommand } from './process';

const REQUIRED_DESYNC_COMMANDS = ['make', 'extract', 'chop', 'cat'] as const;

export type LocalStoreMeasurement = {
  bytes: number;
  chunks: number;
};

export async function verifyDesyncCli(): Promise<void> {
  const { stdout } = await runCommand('desync', ['--help']);
  for (const command of REQUIRED_DESYNC_COMMANDS) {
    if (!new RegExp(`^\\s+${command}\\s`, 'm').test(stdout)) {
      throw new Error(`desync --help does not advertise the required ${command} subcommand.`);
    }
  }
}

export async function storeArtifact(input: {
  artifactPath: string;
  indexPath: string;
  storePath: string;
}): Promise<void> {
  const artifactPath = resolve(input.artifactPath);
  const indexPath = resolve(input.indexPath);
  const storePath = resolve(input.storePath);
  await mkdir(dirname(indexPath), { recursive: true });
  await mkdir(storePath, { recursive: true });
  await runCommand('desync', ['make', '--store', storePath, indexPath, artifactPath]);
}

export async function reconstructArtifact(input: {
  indexPath: string;
  outputPath: string;
  storePath: string;
}): Promise<void> {
  const indexPath = resolve(input.indexPath);
  const outputPath = resolve(input.outputPath);
  const storePath = resolve(input.storePath);
  await mkdir(dirname(outputPath), { recursive: true });
  await runCommand('desync', ['extract', '--store', storePath, indexPath, outputPath]);
}

export async function measureLocalStore(storePath: string): Promise<LocalStoreMeasurement> {
  let bytes = 0;
  let chunks = 0;

  async function visit(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        bytes += (await stat(entryPath)).size;
        chunks += 1;
      } else {
        throw new Error(`Unexpected non-file entry in desync store: ${entryPath}`);
      }
    }
  }

  await visit(resolve(storePath));
  return { bytes, chunks };
}
