import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TOAST_COMPONENT_PATH = join(__dirname, '../../src/components/ui/Toast.tsx');

function readToastComponent(): string {
  return readFileSync(TOAST_COMPONENT_PATH, 'utf8');
}

describe('Toast design system contracts', () => {
  it('delegates toast rendering and theme treatment to HeroUI', () => {
    const source = readToastComponent();

    expect(source).toContain("from '@heroui/react'");
    expect(source).toContain('<HeroUIToast.Provider');
    expect(source).not.toContain('toast-viewport');
    expect(source).not.toContain('setTimeout');
  });

  it('maps every application notification type to a HeroUI variant', () => {
    const source = readToastComponent();

    expect(source).toContain('toast.success');
    expect(source).toContain('toast.danger');
    expect(source).toContain('toast.warning');
    expect(source).toContain('toast.info');
  });
});
