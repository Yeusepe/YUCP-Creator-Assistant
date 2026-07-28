import { useMutation } from '@tanstack/react-query';
import { createLazyFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/api/client';
import { AccountModal, AccountPage, AccountSectionCard } from '@/components/account/AccountPage';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { YucpInput } from '@/components/ui/YucpInput';
import { downloadUserDataExport, formatAccountDateTime } from '@/lib/account';
import {
  getPrivacyPreferenceSummary,
  PRIVACY_PREFERENCES_EVENT,
  type PrivacyPreferences,
  readStoredPrivacyPreferences,
  savePrivacyPreferences,
} from '@/lib/privacyPreferences';

export const Route = createLazyFileRoute('/_authenticated/account/privacy')({
  component: AccountPrivacy,
});

const DATA_RIGHTS = [
  {
    title: 'Right to access',
    desc: 'You can download a copy of all data we hold about you using the export tool below.',
  },
  {
    title: 'Right to rectification',
    desc: 'Profile information is sourced from Discord. Update Discord to refresh it here.',
  },
  {
    title: 'Right to erasure',
    desc: 'You can request deletion of your account and associated data. Processing completes within the GDPR handling window.',
  },
  {
    title: 'Right to portability',
    desc: 'Your data export is delivered as structured JSON so it can be transferred elsewhere.',
  },
  {
    title: 'Right to restrict processing',
    desc: 'Contact us if you need processing restricted while a privacy request is handled.',
  },
] as const;

const PENDING_PREFERENCE_SUMMARY = {
  title: 'Checking saved choice',
  description: 'Loading your saved cookie and diagnostics preference.',
} as const;

function AccountPrivacy() {
  const navigate = useNavigate();
  const toast = useToast();
  const [exportLoading, setExportLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<PrivacyPreferences | null>(null);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const deleteInputRef = useRef<HTMLInputElement>(null);

  const deleteMut = useMutation({
    mutationFn: () => apiClient.delete('/api/connect/user/gdpr-delete'),
    onSuccess: () => {
      navigate({ to: '/' });
    },
    onError: () => {
      const message = 'Failed to submit deletion request. Please try again.';
      setDeleteError(message);
      toast.error('Could not request account deletion', {
        description: message,
      });
    },
  });

  async function handleExport() {
    setExportLoading(true);

    try {
      const blob = await downloadUserDataExport();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'yucp-data-export.json';
      document.body.append(link);
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        link.remove();
      }, 0);
      toast.success('Data export is ready', {
        description: 'Your browser should begin downloading the JSON export.',
      });
    } catch {
      toast.error('Could not prepare data export', {
        description: 'Please try again in a moment.',
      });
    } finally {
      setExportLoading(false);
    }
  }

  const canDelete = deleteInput.trim() === 'DELETE';
  const preferenceSummary = preferencesReady
    ? getPrivacyPreferenceSummary(preferences)
    : PENDING_PREFERENCE_SUMMARY;

  function applyPreference(choice: 'necessary-only' | 'helpful-diagnostics') {
    const next = savePrivacyPreferences(choice, 'account');
    setPreferences(next);
    toast.success('Privacy choices updated', {
      description:
        choice === 'helpful-diagnostics'
          ? 'Helpful diagnostics are now available when you need to reproduce a bug.'
          : 'Optional diagnostics are now disabled. Only necessary cookies remain active.',
    });
  }

  useEffect(() => {
    if (deleteConfirm) {
      deleteInputRef.current?.focus();
    }
  }, [deleteConfirm]);

  useEffect(() => {
    function syncPreferences() {
      setPreferences(readStoredPrivacyPreferences());
      setPreferencesReady(true);
    }

    function handleCustomEvent(event: Event) {
      const detail = (event as CustomEvent<PrivacyPreferences>).detail;
      if (detail) {
        setPreferences(detail);
        setPreferencesReady(true);
        return;
      }
      syncPreferences();
    }

    syncPreferences();

    window.addEventListener('storage', syncPreferences);
    window.addEventListener(PRIVACY_PREFERENCES_EVENT, handleCustomEvent);
    return () => {
      window.removeEventListener('storage', syncPreferences);
      window.removeEventListener(PRIVACY_PREFERENCES_EVENT, handleCustomEvent);
    };
  }, []);

  return (
    <AccountPage>
      <AccountSectionCard
        className="bento-col-8 animate-in animate-in-delay-1"
        eyebrow="Diagnostics"
        title="Cookie and replay choices"
        description="Choose whether optional helpful diagnostics can be enabled when you hit a bug or a slow page."
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            <YucpButton
              yucp="secondary"
              className="btn-ghost--diagnostics justify-center"
              isDisabled={!preferencesReady || preferences?.choice === 'necessary-only'}
              onClick={() => applyPreference('necessary-only')}
            >
              Only necessary
            </YucpButton>
            <YucpButton
              yucp="primary"
              pill
              className="btn-primary--diagnostics justify-center"
              isDisabled={!preferencesReady || preferences?.choice === 'helpful-diagnostics'}
              onClick={() => applyPreference('helpful-diagnostics')}
            >
              Helpful diagnostics
            </YucpButton>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-[20px] border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/70">
            <p className="privacy-preference-summary-title">{preferenceSummary.title}</p>
            <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
              {preferenceSummary.description}
            </p>
            <p className="mt-3 text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
              {!preferencesReady
                ? 'Loading saved preference'
                : preferences
                  ? `Last updated ${formatAccountDateTime(preferences.updatedAt)}`
                  : 'No optional preference stored yet'}
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-[18px] border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-950/70">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Always on</p>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                Necessary first-party cookies and storage keep sign-in, setup, verification, and
                security protections working.
              </p>
            </div>

            <div className="rounded-[18px] border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-950/70">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Helpful diagnostics
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                Optional diagnostics can use anonymous session IDs plus error, performance, and
                replay signals to help investigate bugs and slow pages. Never used for ads or sale.
              </p>
            </div>
          </div>

          <div className="rounded-[18px] border border-sky-200 bg-sky-50 p-4 dark:border-sky-500/30 dark:bg-sky-500/10">
            <p className="text-sm font-semibold text-sky-900 dark:text-sky-100">
              Need help with a bug?
            </p>
            <p className="mt-2 text-sm leading-6 text-sky-800 dark:text-sky-100/85">
              If support asks you to reproduce an issue, you can temporarily enable helpful
              diagnostics here, retry the flow, and switch back to necessary-only afterwards.
            </p>
          </div>
        </div>
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-4 animate-in animate-in-delay-2"
        eyebrow="Export"
        title="Download your data"
        description="Includes profile, verified purchases, authorized apps, and provider connections. Credential values are never included."
        actions={
          <YucpButton
            yucp="secondary"
            isLoading={exportLoading}
            isDisabled={exportLoading}
            onClick={handleExport}
          >
            {exportLoading ? 'Preparing export...' : 'Download export'}
          </YucpButton>
        }
      >
        <p className="account-feature-copy">
          Use an export whenever you want a portable snapshot of your account state. The file is
          generated on demand and downloaded directly to your browser.
        </p>
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-4 animate-in animate-in-delay-2"
        eyebrow="Contact"
        title="Need manual help?"
        description="Some privacy requests are easier to handle with a direct conversation."
        actions={
          <a
            href="/legal/privacy-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="account-btn account-btn--secondary"
          >
            Privacy policy
          </a>
        }
      >
        <div className="account-note-stack">
          <p className="account-feature-copy">
            Contact{' '}
            <a href="mailto:contact@yucp.club" className="account-inline-link">
              contact@yucp.club
            </a>{' '}
            if you need to restrict processing or have questions about the export contents.
          </p>
        </div>
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-7 animate-in animate-in-delay-2"
        eyebrow="Rights"
        title="Your privacy rights"
        description="A concise summary of the rights available to you under applicable privacy law."
      >
        <ul className="account-rights-list">
          {DATA_RIGHTS.map((right) => (
            <li key={right.title} className="account-rights-item">
              <span className="account-rights-item-dot" aria-hidden="true" />
              <span className="account-rights-item-text">
                <span className="account-rights-item-title">{right.title}</span> {right.desc}
              </span>
            </li>
          ))}
        </ul>
      </AccountSectionCard>

      <AccountSectionCard
        className="bento-col-5 animate-in animate-in-delay-3"
        eyebrow="Danger zone"
        title="Request account deletion"
        description="This permanently removes your account, verified purchases, provider links, and related access."
      >
        <div className="account-danger-zone">
          <p className="account-danger-zone-title">Delete account</p>
          <p className="account-danger-zone-desc">
            Discord roles granted by this system will be revoked, and the request will be processed
            within the GDPR deletion window. This action cannot be undone.
          </p>
          <YucpButton
            yucp="danger"
            onClick={() => {
              setDeleteConfirm(true);
              setDeleteInput('');
              setDeleteError(null);
            }}
          >
            Request account deletion
          </YucpButton>
        </div>
      </AccountSectionCard>

      {deleteConfirm ? (
        <AccountModal title="Delete account permanently?" onClose={() => setDeleteConfirm(false)}>
          <p className="account-modal-body">
            This revokes licenses, removes Discord roles, and schedules your data for deletion. Type{' '}
            <strong>DELETE</strong> to confirm.
          </p>
          <YucpInput
            inputRef={deleteInputRef}
            type="text"
            mono
            placeholder="DELETE"
            value={deleteInput}
            onValueChange={setDeleteInput}
            isDisabled={deleteMut.isPending}
            aria-label="Type DELETE to confirm account deletion"
          />
          {deleteError ? <p className="account-inline-error">{deleteError}</p> : null}
          <div className="account-modal-actions">
            <YucpButton
              yucp="secondary"
              onClick={() => setDeleteConfirm(false)}
              isDisabled={deleteMut.isPending}
            >
              Cancel
            </YucpButton>
            <YucpButton
              yucp="danger"
              isLoading={deleteMut.isPending}
              isDisabled={!canDelete || deleteMut.isPending}
              onClick={() => deleteMut.mutate()}
            >
              {deleteMut.isPending ? 'Submitting...' : 'Delete my account'}
            </YucpButton>
          </div>
        </AccountModal>
      ) : null}
    </AccountPage>
  );
}
