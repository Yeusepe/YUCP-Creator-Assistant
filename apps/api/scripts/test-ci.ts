import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testRoot = join(packageRoot, 'src');
const forwardedArgs = process.argv.slice(2);

function collectTestFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(entryPath));
      continue;
    }

    if (/\.test\.[cm]?[tj]sx?$/.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

const testFiles = collectTestFiles(testRoot)
  .map((filePath) => relative(packageRoot, filePath))
  .sort((left, right) => left.localeCompare(right));

for (const testFile of testFiles) {
  const result = spawnSync(process.execPath, ['test', testFile, ...forwardedArgs], {
    cwd: packageRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
