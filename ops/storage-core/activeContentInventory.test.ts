import { describe, expect, test } from 'bun:test';
import { createActiveContentInventory } from './activeContentInventory';

describe('active content inventory', () => {
  test('classifies executable Unity content and ignores passive data', () => {
    const inventory = createActiveContentInventory([
      { normalizedPath: 'Assets/Jammr/Editor/Install.cs', sha256: '11'.repeat(32) },
      { normalizedPath: 'Assets/Jammr/icon.png', sha256: '22'.repeat(32) },
      { normalizedPath: 'Packages/com.yucp.jammr/Runtime/plugin.dll', sha256: '33'.repeat(32) },
      { normalizedPath: 'Assets/Jammr/material.shader', sha256: '44'.repeat(32) },
    ]);

    expect(inventory.entries).toEqual([
      {
        kind: 'unity-editor-script',
        normalizedPath: 'Assets/Jammr/Editor/Install.cs',
        sha256: '11'.repeat(32),
      },
      {
        kind: 'unity-shader-code',
        normalizedPath: 'Assets/Jammr/material.shader',
        sha256: '44'.repeat(32),
      },
      {
        kind: 'native-or-managed-plugin',
        normalizedPath: 'Packages/com.yucp.jammr/Runtime/plugin.dll',
        sha256: '33'.repeat(32),
      },
    ]);
    expect(inventory.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('produces one stable empty inventory digest', () => {
    expect(createActiveContentInventory([])).toEqual(createActiveContentInventory([]));
  });
});
