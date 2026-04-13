import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { YucpInput } from '@/components/ui/YucpInput';

afterEach(cleanup);

const privacySource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account/privacy.lazy.tsx'),
  'utf8'
);
const verifySource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account/verify.lazy.tsx'),
  'utf8'
);

describe('YucpInput component', () => {
  it('renders an input element (role textbox)', () => {
    render(
      <YucpInput label="Delete confirm" placeholder="DELETE" value="" onValueChange={() => {}} />
    );
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('renders with placeholder text', () => {
    render(
      <YucpInput
        aria-label="License key"
        placeholder="Enter key"
        value=""
        onValueChange={() => {}}
      />
    );
    expect(screen.getByPlaceholderText('Enter key')).toBeInTheDocument();
  });

  it('renders a password input when type=password', () => {
    const { container } = render(
      <YucpInput
        label="Key"
        type="password"
        placeholder="enter"
        value=""
        onValueChange={() => {}}
      />
    );
    expect(container.querySelector('input[type="password"]')).toBeInTheDocument();
  });
});

describe('Phase 2I, privacy page input migration', () => {
  it('does not use a raw <input> element (migrated to YucpInput)', () => {
    // The delete confirmation input should be migrated to YucpInput
    expect(privacySource).not.toContain('<input\n');
    expect(privacySource).not.toContain('<input ');
  });

  it('imports YucpInput instead of using raw input', () => {
    expect(privacySource).toContain('YucpInput');
  });
});

describe('Phase 2I, verify page input migration', () => {
  it('does not use a raw <input> element (migrated to YucpInput)', () => {
    expect(verifySource).not.toContain('<input\n');
    expect(verifySource).not.toContain('<input ');
  });

  it('imports YucpInput instead of using raw input', () => {
    expect(verifySource).toContain('YucpInput');
  });
});
