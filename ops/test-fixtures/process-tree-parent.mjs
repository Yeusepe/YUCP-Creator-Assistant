import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const infoPath = process.argv[2];
if (!infoPath) {
  throw new Error('Expected an info path argument');
}

const grandchildPath = fileURLToPath(new URL('./process-tree-grandchild.mjs', import.meta.url));
const grandchild = spawn(process.execPath, [grandchildPath], {
  stdio: 'ignore',
});

if (!grandchild.pid) {
  throw new Error('Failed to spawn grandchild fixture');
}

await writeFile(
  infoPath,
  JSON.stringify({
    parentPid: process.pid,
    grandchildPid: grandchild.pid,
  })
);

setInterval(() => {}, 1_000);
