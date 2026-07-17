import { describe, expect, test } from 'bun:test';
import { runCommand } from './process';

describe('bounded command execution', () => {
  test('kills and rejects a command that exceeds its timeout', async () => {
    const startedAt = Date.now();
    await expect(
      runCommand(process.execPath, ['-e', 'setTimeout(() => undefined, 250)'], {
        timeoutMs: 25,
      })
    ).rejects.toThrow('timed out after 25ms');
    expect(Date.now() - startedAt).toBeLessThan(200);
  });

  test('caps captured stdout and stderr bytes', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', "process.stdout.write('o'.repeat(1024)); process.stderr.write('e'.repeat(1024))"],
      { maxOutputBytes: 64 }
    );

    expect(Buffer.byteLength(result.stdout)).toBe(64);
    expect(Buffer.byteLength(result.stderr)).toBe(64);
  });
});
