import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, './yucpCertificates.ts'), 'utf8');

describe('yucpCertificates env compatibility contract', () => {
  it('supports both legacy and current root key id env names', () => {
    expect(source).toContain('process.env.YUCP_KEY_ID ?? process.env.YUCP_ROOT_KEY_ID ?? null');
  });
});
