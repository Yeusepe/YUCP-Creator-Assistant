import { createLazyFileRoute } from '@tanstack/react-router';
import { useMutation as useConvexMutation, useQuery as useConvexQuery } from 'convex/react';
import { AlertCircle, KeyRound, Mail, ShieldAlert, ShieldCheck, Ticket } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AccountPage, AccountSectionCard } from '@/components/account/AccountPage';
import { AccountSecuritySkeleton } from '@/components/account/AccountSecuritySkeleton';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { verifyRecoveryContactEnrollment as verifyRecoveryContactEnrollmentRequest } from '@/lib/account';
import { authClient } from '@/lib/auth-client';
import { api } from '../../../../../../convex/_generated/api';
import type { Id } from '../../../../../../convex/_generated/dataModel';

export const Route = createLazyFileRoute('/_authenticated/account/security')({
  pendingComponent: SecurityPending,
  component: AccountSecurityPage,
});

interface PasskeyRecord {
  id: string;
  name?: string | null;
  deviceType?: string | null;
  backedUp?: boolean;
  createdAt?: Date | string | number | null;
}

function SecurityPending() {
  return <AccountSecuritySkeleton />;
}

function formatCreatedAt(value: Date | string | number | null | undefined) {
  if (!value) {
    return 'Unknown date';
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown date';
  }

  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function AccountSecurityPage() {
  const toast = useToast();
  const securityOverview = useConvexQuery(api.accountSecurity.getSecurityOverview, {});
  const syncSecurityState = useConvexMutation(api.accountSecurity.syncSecurityState);
  const prepareRecoveryContactEnrollment = useConvexMutation(
    api.accountSecurity.prepareRecoveryContactEnrollment
  );
  const removeRecoveryContact = useConvexMutation(api.accountSecurity.removeRecoveryContact);
  const markAuthenticatorCompromised = useConvexMutation(
    api.accountSecurity.markAuthenticatorCompromised
  );
  const revokeAllUserSessions = useConvexMutation(api.accountSecurity.revokeAllUserSessions);
  const dismissRecoveryPrompt = useConvexMutation(api.accountSecurity.dismissRecoveryPrompt);
  const passkeysQuery = authClient.useListPasskeys();

  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [recoveryEmailOtp, setRecoveryEmailOtp] = useState('');
  const [pendingRecoveryEmail, setPendingRecoveryEmail] = useState<string | null>(null);
  const [freshBackupCodes, setFreshBackupCodes] = useState<string[]>([]);
  const passkeys: PasskeyRecord[] = passkeysQuery.data ?? [];
  const isLoadingPasskeys = passkeysQuery.isPending;

  const summaryItems = useMemo(
    () => [
      {
        label: 'Passkeys',
        value: securityOverview?.passkeyCount ?? 0,
        isPolicy: false,
      },
      {
        label: 'Backup codes left',
        value: securityOverview?.backupCodeCount ?? 0,
        isPolicy: false,
      },
      {
        label: 'Recovery inboxes',
        value: securityOverview?.verifiedRecoveryEmailCount ?? 0,
        isPolicy: false,
      },
      {
        label: 'Account type',
        value: securityOverview?.isCreatorAccount ? 'Creator' : 'Personal',
        isPolicy: true,
      },
    ],
    [securityOverview]
  );

  async function refreshPasskeys(eventType?: Parameters<typeof syncSecurityState>[0]['eventType']) {
    await syncSecurityState(eventType ? { eventType } : {});
    await passkeysQuery.refetch();
  }

  async function handleAddPasskey() {
    setPendingAction('add-passkey');
    try {
      const result = await authClient.passkey.addPasskey();
      if (result.error) {
        throw new Error(result.error.message ?? 'Could not add passkey');
      }
      await refreshPasskeys('account.security.passkey.added');
      toast.success('Passkey added', {
        description: 'This passkey is now available as a recovery factor.',
      });
    } catch (error) {
      toast.error('Could not add passkey', {
        description: error instanceof Error ? error.message : 'Try again from this browser.',
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function handleDeletePasskey(passkeyId: string) {
    setPendingAction(`delete-passkey:${passkeyId}`);
    try {
      const result = await authClient.passkey.deletePasskey({ id: passkeyId });
      if (result.error) {
        throw new Error(result.error.message ?? 'Could not remove passkey');
      }
      await refreshPasskeys('account.security.passkey.removed');
      toast.success('Passkey removed');
    } catch (error) {
      toast.error('Could not remove passkey', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function handleEnableBackupCodes() {
    setPendingAction('enable-backup-codes');
    try {
      const result = await authClient.twoFactor.enable({});
      if (result.error) {
        throw new Error(result.error.message ?? 'Could not enable backup codes');
      }
      const codes = result.data?.backupCodes ?? [];
      setFreshBackupCodes(codes);
      await syncSecurityState({
        eventType: 'account.security.backup_codes.regenerated',
      });
      toast.success('Backup codes ready', {
        description: 'Store them somewhere offline. Each code works once.',
      });
    } catch (error) {
      toast.error('Could not enable backup codes', {
        description:
          error instanceof Error ? error.message : 'The security state could not be updated.',
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function handleRegenerateBackupCodes() {
    setPendingAction('regenerate-backup-codes');
    try {
      const result = await authClient.twoFactor.generateBackupCodes({});
      if (result.error) {
        throw new Error(result.error.message ?? 'Could not regenerate backup codes');
      }
      const codes = result.data?.backupCodes ?? [];
      setFreshBackupCodes(codes);
      await syncSecurityState({
        eventType: 'account.security.backup_codes.regenerated',
      });
      toast.success('Backup codes regenerated');
    } catch (error) {
      toast.error('Could not regenerate backup codes', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function handleStartRecoveryEmailEnrollment() {
    if (!recoveryEmail.trim()) {
      toast.error('Enter a recovery email');
      return;
    }

    setPendingAction('send-recovery-email-otp');
    try {
      const prepared = await prepareRecoveryContactEnrollment({
        email: recoveryEmail.trim(),
      });
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: prepared.email,
        type: 'email-verification',
      });
      if (result.error) {
        throw new Error(result.error.message ?? 'Could not send verification code');
      }
      setPendingRecoveryEmail(prepared.email);
      toast.success('Verification code sent', {
        description: 'Enter the code from your recovery inbox to finish enrollment.',
      });
    } catch (error) {
      toast.error('Could not send verification code', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function handleVerifyRecoveryEmail() {
    if (!pendingRecoveryEmail || !recoveryEmailOtp.trim()) {
      toast.error('Enter the verification code');
      return;
    }

    setPendingAction('verify-recovery-email-otp');
    try {
      await verifyRecoveryContactEnrollmentRequest(pendingRecoveryEmail, recoveryEmailOtp.trim());
      setPendingRecoveryEmail(null);
      setRecoveryEmail('');
      setRecoveryEmailOtp('');
      toast.success('Recovery email verified');
    } catch (error) {
      toast.error('Could not verify recovery email', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function handleRemoveRecoveryEmail(contactId: Id<'account_recovery_contacts'>) {
    setPendingAction(`remove-recovery-email:${contactId}`);
    try {
      await removeRecoveryContact({ contactId });
      toast.success('Recovery email removed');
    } catch (error) {
      toast.error('Could not remove recovery email', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function handleCompromised(
    kind: 'primary-email' | 'discord' | 'recovery-email',
    contactId?: Id<'account_recovery_contacts'>
  ) {
    setPendingAction(kind);
    try {
      await markAuthenticatorCompromised({
        kind,
        ...(contactId ? { contactId } : {}),
      });
      toast.warning('Security factor marked as compromised', {
        description: 'Recovery from that factor is now suppressed until you replace it.',
      });
    } catch (error) {
      toast.error('Could not update compromise state', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function handleDismissPrompt() {
    setPendingAction('dismiss-prompt');
    try {
      await dismissRecoveryPrompt({});
      toast.info('Recovery reminder dismissed for now');
    } catch (error) {
      toast.error('Could not dismiss reminder', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function handleRevokeSessions() {
    setPendingAction('revoke-sessions');
    try {
      await revokeAllUserSessions({});
      toast.success('All sessions revoked', {
        description: 'Sign in again on the devices you still trust.',
      });
    } catch (error) {
      toast.error('Could not revoke sessions', {
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setPendingAction(null);
    }
  }

  if (securityOverview === undefined) {
    return <SecurityPending />;
  }

  return (
    <AccountPage>
      <AccountSectionCard
        className="bento-col-12"
        leading={<ShieldCheck strokeWidth={1.75} aria-hidden />}
        eyebrow="Recovery status"
        title="Can you get back in without Discord?"
        description="You usually sign in with Discord. Add at least one backup so you are not locked out if you lose Discord, your phone, or access to your main email."
        actions={
          <YucpButton
            yucp="secondary"
            isLoading={pendingAction === 'dismiss-prompt'}
            onPress={handleDismissPrompt}
          >
            Dismiss reminder
          </YucpButton>
        }
      >
        {securityOverview.shouldShowPrompt ? (
          <div className="account-status-banner account-status-banner--warning account-status-banner--notice">
            <div className="account-status-banner-main">
              <span className="account-status-banner-icon" aria-hidden>
                <AlertCircle strokeWidth={1.75} />
              </span>
              <div className="account-status-banner-copy">
                <strong>Add a backup before you need it</strong>
                <span className="account-status-banner-detail">
                  {securityOverview.isCreatorAccount
                    ? 'Your Creator Identity should keep a passkey, backup codes, or a second inbox on file.'
                    : 'A passkey, backup codes, or a verified recovery email keeps you from getting stuck.'}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="account-status-banner account-status-banner--success">
            <div className="account-status-banner-copy">
              <strong>You have recovery options on file</strong>
              <span className="account-status-banner-detail">
                Keep at least one passkey, backup code set, or recovery email active so support is
                easier if something breaks.
              </span>
            </div>
          </div>
        )}

        <ul className="account-recovery-metrics" aria-label="Recovery snapshot">
          {summaryItems.map((item) => (
            <li key={item.label} className={joinMetricClass(item.isPolicy)}>
              <span>{item.label}</span>
              <span className="account-recovery-metric-value">{item.value}</span>
            </li>
          ))}
        </ul>
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-12"
        eyebrow="Backup sign-in methods"
        title="Pick what works for you"
        description="You do not need everything here—choose what you can keep safe. Passkeys are the smoothest; codes and a spare email are great fallbacks."
      >
        <p className="account-recovery-intro">
          Each option below is independent. Turn on one now, then layer more over time.
        </p>

        <div className="account-recovery-board">
          <article className="account-recovery-method">
            <div className="account-recovery-method-head">
              <div className="account-recovery-method-title-group">
                <span className="account-recovery-method-icon">
                  <KeyRound strokeWidth={1.75} aria-hidden />
                </span>
                <div className="account-recovery-method-titles">
                  <p className="account-recovery-method-name">Passkeys</p>
                  <p className="account-recovery-method-blurb">
                    Use your phone, laptop, or a security key instead of typing a password when you
                    need to recover access.
                  </p>
                </div>
              </div>
            </div>
            <div className="account-recovery-method-body">
              {isLoadingPasskeys ? (
                <p className="account-feature-copy">Loading passkeys…</p>
              ) : passkeys.length === 0 ? (
                <p className="account-feature-copy">
                  None added yet. Start from this browser or plug in a hardware key.
                </p>
              ) : (
                <div className="account-security-list">
                  {passkeys.map((passkey) => (
                    <div key={passkey.id} className="account-security-row">
                      <div className="account-security-copy">
                        <p className="account-security-title">
                          {passkey.name || 'Unnamed passkey'}
                        </p>
                        <p className="account-security-meta">
                          {passkey.deviceType || 'Authenticator device'} · Added{' '}
                          {formatCreatedAt(passkey.createdAt)}
                          {passkey.backedUp ? ' · Synced' : ''}
                        </p>
                      </div>
                      <YucpButton
                        yucp="secondary"
                        isLoading={pendingAction === `delete-passkey:${passkey.id}`}
                        onPress={() => handleDeletePasskey(passkey.id)}
                      >
                        Remove
                      </YucpButton>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="account-recovery-method-actions">
              <YucpButton
                yucp="primary"
                isLoading={pendingAction === 'add-passkey'}
                onPress={handleAddPasskey}
              >
                Add passkey
              </YucpButton>
            </div>
          </article>

          <article className="account-recovery-method">
            <div className="account-recovery-method-head">
              <div className="account-recovery-method-title-group">
                <span className="account-recovery-method-icon account-recovery-method-icon--amber">
                  <Ticket strokeWidth={1.75} aria-hidden />
                </span>
                <div className="account-recovery-method-titles">
                  <p className="account-recovery-method-name">Backup codes</p>
                  <p className="account-recovery-method-blurb">
                    One-time codes you can store offline. Each code works a single time if other
                    options fail.
                  </p>
                </div>
              </div>
            </div>
            <div className="account-recovery-method-body">
              <p className="account-feature-copy">
                {securityOverview.hasBackupCodes
                  ? `${securityOverview.backupCodeCount} codes left. Regenerating creates a fresh list and voids the old one.`
                  : 'Turn on backup codes once—we will generate a set you can print or store in a password manager.'}
              </p>
              {freshBackupCodes.length > 0 ? (
                <div className="account-security-code-grid">
                  {freshBackupCodes.map((code) => (
                    <code key={code} className="account-security-code">
                      {code}
                    </code>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="account-recovery-method-actions">
              {securityOverview.hasBackupCodes ? (
                <YucpButton
                  yucp="secondary"
                  isLoading={pendingAction === 'regenerate-backup-codes'}
                  onPress={handleRegenerateBackupCodes}
                >
                  Regenerate codes
                </YucpButton>
              ) : (
                <YucpButton
                  yucp="primary"
                  isLoading={pendingAction === 'enable-backup-codes'}
                  onPress={handleEnableBackupCodes}
                >
                  Enable backup codes
                </YucpButton>
              )}
            </div>
          </article>

          <article className="account-recovery-method account-recovery-method--span-full">
            <div className="account-recovery-method-head">
              <div className="account-recovery-method-title-group">
                <span className="account-recovery-method-icon account-recovery-method-icon--violet">
                  <Mail strokeWidth={1.75} aria-hidden />
                </span>
                <div className="account-recovery-method-titles">
                  <p className="account-recovery-method-name">Recovery email</p>
                  <p className="account-recovery-method-blurb">
                    A separate inbox (not the same as your Discord login email) where we can send a
                    verification code if you are locked out.
                  </p>
                </div>
              </div>
            </div>
            <div className="account-recovery-method-body">
              <div className="account-security-form">
                <label className="account-security-label" htmlFor="recovery-email">
                  Email address
                </label>
                <input
                  id="recovery-email"
                  className="account-security-input"
                  type="email"
                  value={recoveryEmail}
                  onChange={(event) => setRecoveryEmail(event.target.value)}
                  placeholder="you@personal-domain.com"
                  autoComplete="email"
                />
                <YucpButton
                  yucp="primary"
                  isLoading={pendingAction === 'send-recovery-email-otp'}
                  onPress={handleStartRecoveryEmailEnrollment}
                >
                  Send code
                </YucpButton>
              </div>

              {pendingRecoveryEmail ? (
                <div className="account-security-form">
                  <label className="account-security-label" htmlFor="recovery-email-otp">
                    Code from that inbox
                  </label>
                  <input
                    id="recovery-email-otp"
                    className="account-security-input"
                    type="text"
                    inputMode="numeric"
                    value={recoveryEmailOtp}
                    onChange={(event) => setRecoveryEmailOtp(event.target.value)}
                    placeholder="123456"
                    autoComplete="one-time-code"
                  />
                  <YucpButton
                    yucp="secondary"
                    isLoading={pendingAction === 'verify-recovery-email-otp'}
                    onPress={handleVerifyRecoveryEmail}
                  >
                    Confirm email
                  </YucpButton>
                </div>
              ) : null}

              <div className="account-security-list">
                {securityOverview.recoveryContacts.length === 0 ? (
                  <p className="account-feature-copy">No verified recovery email yet.</p>
                ) : (
                  securityOverview.recoveryContacts.map(
                    (contact: (typeof securityOverview.recoveryContacts)[number]) => (
                      <div key={contact.id} className="account-security-row">
                        <div className="account-security-copy">
                          <p className="account-security-title">
                            {contact.email || 'Encrypted recovery email'}
                          </p>
                          <p className="account-security-meta">
                            {contact.status} · Added {formatCreatedAt(contact.addedAt)}
                          </p>
                        </div>
                        <div className="account-inline-actions">
                          <YucpButton
                            yucp="secondary"
                            isLoading={pendingAction === `remove-recovery-email:${contact.id}`}
                            onPress={() =>
                              handleRemoveRecoveryEmail(
                                contact.id as Id<'account_recovery_contacts'>
                              )
                            }
                          >
                            Remove
                          </YucpButton>
                          <YucpButton
                            yucp="danger"
                            isLoading={pendingAction === 'recovery-email'}
                            onPress={() =>
                              handleCompromised(
                                'recovery-email',
                                contact.id as Id<'account_recovery_contacts'>
                              )
                            }
                          >
                            Mark unsafe
                          </YucpButton>
                        </div>
                      </div>
                    )
                  )
                )}
              </div>
            </div>
          </article>
        </div>
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-12 account-surface-card--security-emergency"
        leading={<ShieldAlert strokeWidth={1.75} aria-hidden />}
        eyebrow="If access might be stolen"
        title="Pause risky channels"
        description="Use these only when you suspect someone else reached your email or Discord. We will block recovery through the channel you mark until you replace it."
      >
        <div className="account-emergency-actions">
          <p className="account-emergency-hint">
            After marking a channel, sign out everywhere so new sign-ins must use a method you still
            trust.
          </p>
          <div className="account-emergency-actions-row">
            <YucpButton
              yucp="danger"
              isLoading={pendingAction === 'primary-email'}
              onPress={() => handleCompromised('primary-email')}
            >
              Primary email unsafe
            </YucpButton>
            <YucpButton
              yucp="danger"
              isLoading={pendingAction === 'discord'}
              onPress={() => handleCompromised('discord')}
            >
              Discord unsafe
            </YucpButton>
            <YucpButton
              yucp="secondary"
              isLoading={pendingAction === 'revoke-sessions'}
              onPress={handleRevokeSessions}
            >
              Sign out everywhere
            </YucpButton>
          </div>
        </div>
      </AccountSectionCard>
    </AccountPage>
  );
}

function joinMetricClass(isPolicy: boolean) {
  return ['account-recovery-metric', isPolicy ? 'account-recovery-metric--policy' : '']
    .filter(Boolean)
    .join(' ');
}
