import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addPasskeyMock,
  signInPasskeyMock,
  signInSocialMock,
  startAccountRecoveryMock,
  verifyAccountRecoveryBackupCodeMock,
  verifyAccountRecoveryEmailMock,
  logWebErrorMock,
} = vi.hoisted(() => ({
  addPasskeyMock: vi.fn(),
  signInPasskeyMock: vi.fn(),
  signInSocialMock: vi.fn(),
  startAccountRecoveryMock: vi.fn(),
  verifyAccountRecoveryBackupCodeMock: vi.fn(),
  verifyAccountRecoveryEmailMock: vi.fn(),
  logWebErrorMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
  }),
  redirect: vi.fn(),
}));

vi.mock('@/components/page/PageLoadingOverlay', () => ({
  PageLoadingOverlay: () => null,
}));

vi.mock('@/components/three/CloudBackground', () => ({
  CloudBackground: () => null,
}));

vi.mock('@/hooks/usePageLoadingTransition', () => ({
  usePageLoadingTransition:
    ({ onReveal }: { onReveal: () => void }) =>
    () =>
      onReveal(),
}));

vi.mock('@/lib/account', () => ({
  startAccountRecovery: startAccountRecoveryMock,
  verifyAccountRecoveryBackupCode: verifyAccountRecoveryBackupCodeMock,
  verifyAccountRecoveryEmail: verifyAccountRecoveryEmailMock,
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    signIn: {
      passkey: signInPasskeyMock,
      social: signInSocialMock,
    },
    passkey: {
      addPasskey: addPasskeyMock,
    },
  },
}));

vi.mock('@/lib/routeStyles', () => ({
  routeStyleHrefs: { signIn: [] },
  routeStylesheetLinks: () => [],
}));

vi.mock('@/lib/server/auth', () => ({
  getAuthSession: vi.fn(),
}));

vi.mock('@/lib/webDiagnostics', () => ({
  logWebError: logWebErrorMock,
}));

import { SignInPage } from '@/routes/sign-in';

describe('sign-in passkey flows', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    addPasskeyMock.mockReset();
    signInPasskeyMock.mockReset();
    signInSocialMock.mockReset();
    startAccountRecoveryMock.mockReset();
    verifyAccountRecoveryBackupCodeMock.mockReset();
    verifyAccountRecoveryEmailMock.mockReset();
    logWebErrorMock.mockReset();

    Object.defineProperty(window.location, 'assign', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('redirects immediately after a successful passkey sign-in', async () => {
    signInPasskeyMock.mockResolvedValue({
      data: {
        session: { id: 'session-1' },
        user: { id: 'user-1' },
      },
      error: null,
    });

    render(<SignInPage redirectTo="/dashboard/security" />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with passkey' }));

    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith('/dashboard/security'));
    expect(screen.queryByText("You're signed in")).not.toBeInTheDocument();
  });

  it('finishes recovery without overriding the device passkey label and redirects immediately', async () => {
    startAccountRecoveryMock.mockResolvedValue({
      message: 'Recovery email sent.',
    });
    verifyAccountRecoveryBackupCodeMock.mockResolvedValue({
      recoveryPasskeyContext: 'recovery-context-token',
    });
    addPasskeyMock.mockResolvedValue({
      data: { id: 'passkey-1', name: 'Creator Identity passkey' },
      error: null,
    });
    signInPasskeyMock.mockResolvedValue({
      data: {
        session: { id: 'session-2' },
        user: { id: 'user-2' },
      },
      error: null,
    });

    render(<SignInPage redirectTo="/dashboard/security" />);

    fireEvent.click(screen.getByRole('button', { name: "Can't sign in?" }));
    fireEvent.change(screen.getByLabelText('Account or recovery email'), {
      target: { value: 'creator@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send recovery options' }));

    await screen.findByRole('button', { name: 'Use backup code' });

    fireEvent.change(screen.getByLabelText('Backup code'), {
      target: { value: 'BACKUP-CODE-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use backup code' }));

    await screen.findByText('Finish recovery with a new passkey');
    fireEvent.click(screen.getByRole('button', { name: 'Register recovery passkey' }));

    await waitFor(() =>
      expect(addPasskeyMock).toHaveBeenCalledWith({
        context: 'recovery-context-token',
      })
    );
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith('/dashboard/security'));
    expect(screen.queryByLabelText('Passkey name')).not.toBeInTheDocument();
  });

  it('verifies recovery against the lookup email that started the flow even if the input changes later', async () => {
    startAccountRecoveryMock.mockResolvedValue({
      message: 'Recovery email sent.',
    });
    verifyAccountRecoveryEmailMock.mockResolvedValue({
      recoveryPasskeyContext: 'recovery-context-token',
    });

    render(<SignInPage redirectTo="/dashboard/security" />);

    fireEvent.click(screen.getByRole('button', { name: "Can't sign in?" }));
    fireEvent.change(screen.getByLabelText('Account or recovery email'), {
      target: { value: 'creator@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send recovery options' }));

    await screen.findByRole('button', { name: 'Verify email code' });

    fireEvent.change(screen.getByLabelText('Account or recovery email'), {
      target: { value: 'other@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Email code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify email code' }));

    await waitFor(() =>
      expect(verifyAccountRecoveryEmailMock).toHaveBeenCalledWith('creator@example.com', '123456')
    );
  });
});
