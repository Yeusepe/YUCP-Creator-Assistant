import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccountModal } from '@/components/account/AccountPage';

describe('AccountModal', () => {
  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn();
    render(
      <AccountModal title="Test Modal" onClose={onClose}>
        <p>content</p>
      </AccountModal>
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose for other keys', () => {
    const onClose = vi.fn();
    render(
      <AccountModal title="Test Modal" onClose={onClose}>
        <p>content</p>
      </AccountModal>
    );

    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders with aria-labelledby linking to title', () => {
    render(
      <AccountModal title="My Dialog" onClose={vi.fn()}>
        <p>body</p>
      </AccountModal>
    );

    const dialog = screen.getByRole('dialog');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    const heading = document.getElementById(labelId!);
    expect(heading?.textContent).toBe('My Dialog');
  });
});
