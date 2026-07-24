import { buildRepresentativePackageCorpus } from './packageCorpus';

function readOutputArgument(args: string[]): string {
  const index = args.indexOf('--output');
  const output = index >= 0 ? args[index + 1] : undefined;
  if (!output) {
    throw new Error('Use --output <absolute-output-path>');
  }
  return output;
}

const outputPath = readOutputArgument(process.argv.slice(2));
const manifest = await buildRepresentativePackageCorpus(outputPath);
console.info(`PACKAGE_CORPUS_MANIFEST=${JSON.stringify(manifest)}`);
