import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildPackageContractGoldenVectors } from './packageContractGoldenVectors';

const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (!outputPath) {
  throw new Error('Use --output <absolute-output-path>');
}

const resolvedOutput = resolve(outputPath);
await mkdir(dirname(resolvedOutput), { recursive: true });
await writeFile(
  resolvedOutput,
  `${JSON.stringify(await buildPackageContractGoldenVectors(), null, 2)}\n`
);
console.info(`PACKAGE_CONTRACT_VECTORS=${resolvedOutput}`);
