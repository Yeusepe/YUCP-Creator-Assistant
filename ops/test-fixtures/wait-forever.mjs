import { writeFile } from 'node:fs/promises';

const startedPath = process.argv[2];

if (startedPath) {
  await writeFile(startedPath, 'started\n', 'utf8');
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => undefined, 60_000);
