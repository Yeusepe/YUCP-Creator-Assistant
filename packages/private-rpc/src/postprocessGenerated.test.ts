import { afterEach, describe, expect, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function runPostprocess(source: string) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'private-rpc-postprocess-'));
  tempRoots.push(tempRoot);

  const scriptsDir = join(tempRoot, 'scripts');
  const srcDir = join(tempRoot, 'src');
  const scriptPath = join(scriptsDir, 'postprocess-generated.ts');
  const helperPath = join(srcDir, 'generatedPostprocess.ts');
  const generatedPath = join(srcDir, 'generated.ts');

  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });
  copyFileSync(resolve(import.meta.dir, '../scripts/postprocess-generated.ts'), scriptPath);
  copyFileSync(resolve(import.meta.dir, './generatedPostprocess.ts'), helperPath);
  writeFileSync(generatedPath, source, 'utf8');

  const result = Bun.spawnSync({
    cmd: [process.execPath, 'run', scriptPath],
    cwd: tempRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });

  expect(result.exitCode).toBe(0);
  return readFileSync(generatedPath, 'utf8');
}

describe('postprocess-generated script', () => {
  it('normalizes CRLF line endings to LF when prepending the ts-nocheck banner', () => {
    const output = runPostprocess('export const first = 1;\r\nexport const second = 2;\r\n');
    expect(output.startsWith('// @ts-nocheck\n')).toBe(true);
    expect(output.includes('\r\n')).toBe(false);
  });

  it('preserves LF line endings when prepending the ts-nocheck banner', () => {
    const output = runPostprocess('export const first = 1;\nexport const second = 2;\n');
    expect(output.startsWith('// @ts-nocheck\n')).toBe(true);
    expect(output.includes('\r\n')).toBe(false);
  });
});
