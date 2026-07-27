import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'native-transfer-helper.yml');

describe('native transfer helper CI', () => {
  test('runs for every native module and workflow change', () => {
    const source = readFileSync(WORKFLOW, 'utf8');

    expect(source).toContain('"Verify/Native/transfer-helper/**"');
    expect(source).toContain('".github/workflows/native-transfer-helper.yml"');
  });

  test('uses the pinned module toolchain on Linux and Windows', () => {
    const source = readFileSync(WORKFLOW, 'utf8');

    expect(source).toContain(`runs-on: \${{ matrix.runner }}`);
    expect(source).toContain('runner: ubuntu-latest');
    expect(source).toContain('runner: windows-latest');
    expect(source).toContain('actions/setup-go@4a3601121dd01d1626a1e23e37211e3254c1c06c');
    expect(source).toContain("go-version-file: 'Verify/Native/transfer-helper/go.mod'");
    expect(source).toContain("cache-dependency-path: 'Verify/Native/transfer-helper/go.sum'");
  });

  test('tests the module and builds every supported command', () => {
    const source = readFileSync(WORKFLOW, 'utf8');

    expect(source).toContain('go test ./...');
    expect(source).toContain(
      'go test -tags=integrationharness ./cmd/yucp-package-broker-test-harness'
    );
    expect(source).toContain('go build ./cmd/yucp-transfer-helper');
    expect(source).toContain('go build ./cmd/yucp-package-broker');
    expect(source).toContain(
      'go build -tags=integrationharness ./cmd/yucp-package-broker-test-harness'
    );
    expect(source).toContain('go build ./cmd/yucp-tuf-root');
    expect(source).toContain('go build ./cmd/yucp-tuf-online-repository');
    expect(source).toContain('go build ./cmd/yucp-local-tuf-repository');
  });
});
