import {
  interactiveStorageProfileRoot,
  resetInteractiveStorageHarness,
} from './testing/interactiveStorageHarness';

export function resolveResetEpoch(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--epoch' || !/^[0-9a-f]{12}$/.test(argv[1] ?? '')) {
    throw new Error('Usage: bun run dev:storage:reset -- --epoch <12-character-storage-epoch>');
  }
  return argv[1] as string;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const expectedEpoch = resolveResetEpoch(argv);
  await resetInteractiveStorageHarness({
    expectedEpoch,
    profileRoot: interactiveStorageProfileRoot(),
  });
  process.stdout.write(`Reset interactive storage epoch ${expectedEpoch}.\n`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error('[dev-storage-reset]', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
