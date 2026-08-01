import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DestructiveActionButton } from '@/components/ui/DestructiveActionButton';
import { YucpButton } from '@/components/ui/YucpButton';

describe('shared action buttons', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('keeps primary and secondary actions on the HeroUI button system', () => {
    render(
      <>
        <YucpButton yucp="primary">Continue</YucpButton>
        <YucpButton yucp="secondary">Not now</YucpButton>
      </>
    );

    const primary = screen.getByRole('button', { name: 'Continue' });
    const secondary = screen.getByRole('button', { name: 'Not now' });

    expect(primary).toHaveClass('button', 'button--primary');
    expect(secondary).toHaveClass('button', 'button--secondary');
    expect(primary).not.toHaveClass('btn-primary');
    expect(secondary).not.toHaveClass('btn-ghost');
  });

  it('uses one HeroUI Pro pressable button and only confirms after the hold completes', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();

    render(
      <DestructiveActionButton onConfirm={onConfirm} holdDuration={800}>
        Delete release
      </DestructiveActionButton>
    );

    const button = screen.getByRole('button', { name: 'Hold to delete release' });
    expect(button).toHaveClass('button', 'button--danger-soft', 'pressable-feedback');
    expect(button).toHaveClass('rounded-3xl');
    expect(screen.getAllByRole('button')).toHaveLength(1);

    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.pointerDown(button, { button: 0, isPrimary: true });
    act(() => vi.advanceTimersByTime(799));
    expect(onConfirm).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('shows an explicit disabled pending state', () => {
    render(
      <DestructiveActionButton isPending pendingLabel="Deleting release..." onConfirm={() => {}}>
        Delete release
      </DestructiveActionButton>
    );

    expect(screen.getByRole('button', { name: 'Deleting release...' })).toBeDisabled();
  });
});
