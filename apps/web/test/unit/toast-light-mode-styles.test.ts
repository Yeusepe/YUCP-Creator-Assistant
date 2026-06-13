import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TOAST_CSS_PATH = join(__dirname, '../../src/styles/toast.css');

function readToastStyles(): string {
  return readFileSync(TOAST_CSS_PATH, 'utf8');
}

describe('Toast light mode style contracts', () => {
  it('defines dedicated light and dark palette tokens for toast surfaces', () => {
    const source = readToastStyles();

    expect(source).toContain('--toast-surface:');
    expect(source).toContain('--toast-border:');
    expect(source).toContain('.dark {');
    expect(source).toContain('--toast-surface: rgba(8, 12, 24, 0.72);');
  });

  it('defines separate light and dark treatments for info and success toasts', () => {
    const source = readToastStyles();

    expect(source).toContain('.toast.toast-info {');
    expect(source).toContain('.dark .toast.toast-info {');
    expect(source).toContain('.toast.toast-success {');
    expect(source).toContain('.toast-success .toast-icon {');
  });

  it('keeps persistent toast accents visible in both themes', () => {
    const source = readToastStyles();

    expect(source).toContain('.toast.toast-persistent::after {');
    expect(source).toContain('.dark .toast.toast-persistent::after {');
  });
});
