import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

import { AccountModal } from '@/components/account/AccountPage';

describe('AccountModal focus trap', () => {
  it('moves initial focus to the first tabbable element', () => {
    render(
      <AccountModal title="Focus Trap Test" onClose={vi.fn()}>
        <button type="button" data-testid="btn-first">
          First
        </button>
        <button type="button" data-testid="btn-second">
          Second
        </button>
      </AccountModal>
    );

    expect(document.activeElement).toBe(screen.getByTestId('btn-first'));
  });

  it('traps focus: Tab from last focusable element wraps to first', () => {
    render(
      <AccountModal title="Focus Trap Test" onClose={vi.fn()}>
        <button type="button" data-testid="btn-first">
          First
        </button>
        <button type="button" data-testid="btn-second">
          Second
        </button>
      </AccountModal>
    );

    const firstBtn = screen.getByTestId('btn-first');
    const secondBtn = screen.getByTestId('btn-second');

    secondBtn.focus();
    expect(document.activeElement).toBe(secondBtn);

    fireEvent.keyDown(secondBtn, { key: 'Tab', shiftKey: false });
    expect(document.activeElement).toBe(firstBtn);
  });

  it('traps focus: Shift+Tab from first focusable element wraps to last', () => {
    const { container: _c } = render(
      <AccountModal title="Focus Trap Test" onClose={vi.fn()}>
        <button type="button" data-testid="btn-first">
          First
        </button>
        <button type="button" data-testid="btn-second">
          Second
        </button>
      </AccountModal>
    );

    const firstBtn = screen.getByTestId('btn-first');
    const secondBtn = screen.getByTestId('btn-second');

    firstBtn.focus();
    expect(document.activeElement).toBe(firstBtn);

    fireEvent.keyDown(firstBtn, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(secondBtn);
  });

  it('traps focus when the dialog container itself is focused', () => {
    render(
      <AccountModal title="Focus Trap Test" onClose={vi.fn()}>
        <button type="button" data-testid="btn-first">
          First
        </button>
        <button type="button" data-testid="btn-second">
          Second
        </button>
      </AccountModal>
    );

    const dialog = screen.getByRole('dialog');
    const secondBtn = screen.getByTestId('btn-second');

    dialog.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(secondBtn);
  });

  it('does not wrap focus when Tab is pressed on a non-boundary element', () => {
    render(
      <AccountModal title="Focus Trap Test" onClose={vi.fn()}>
        <button type="button" data-testid="btn-first">
          First
        </button>
        <button type="button" data-testid="btn-middle">
          Middle
        </button>
        <button type="button" data-testid="btn-last">
          Last
        </button>
      </AccountModal>
    );

    const middleBtn = screen.getByTestId('btn-middle');
    middleBtn.focus();

    // Tab on middle element, should NOT prevent default (no wrapping)
    const _event = fireEvent.keyDown(middleBtn, { key: 'Tab', shiftKey: false });
    // activeElement stays at middle since we don't intervene on non-boundary
    expect(document.activeElement).toBe(middleBtn);
  });
});

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
    const { container } = render(
      <AccountModal title="My Dialog" onClose={vi.fn()}>
        <p>body</p>
      </AccountModal>
    );

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    const labelId = dialog?.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    const heading = container.querySelector(`#${labelId}`);
    expect(heading?.textContent).toBe('My Dialog');
  });
});
