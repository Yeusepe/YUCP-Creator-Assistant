import { useMutation } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/api/client';
import { AccountModal, AccountPage, AccountSectionCard } from '@/components/account/AccountPage';
import { useToast } from '@/components/ui/Toast';
import { downloadUserDataExport } from '@/lib/account';

export const Route = createFileRoute('/account/privacy')({
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

function AccountPrivacy() {
  const navigate = useNavigate();
  const toast = useToast();
  const [exportLoading, setExportLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
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
      link.click();
      URL.revokeObjectURL(url);
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

  useEffect(() => {
    if (deleteConfirm) {
      deleteInputRef.current?.focus();
    }
  }, [deleteConfirm]);

  return (
    <AccountPage>
      <AccountSectionCard
        className="bento-col-8 animate-in animate-in-delay-1"
        eyebrow="Export"
        title="Download your data"
        description="Includes profile, verified purchases, authorized apps, and provider connections. Credential values are never included."
        actions={
          <button
            type="button"
            className={`account-btn account-btn--secondary${exportLoading ? ' btn-loading' : ''}`}
            onClick={handleExport}
            disabled={exportLoading}
          >
            {exportLoading ? (
              <>
                <span className="btn-loading-spinner" aria-hidden="true" />
                Preparing export...
              </>
            ) : (
              'Download export'
            )}
          </button>
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
            <a href="mailto:privacy@yucp.club" className="account-inline-link">
              privacy@yucp.club
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
          <button
            type="button"
            className="account-btn account-btn--danger"
            onClick={() => {
              setDeleteConfirm(true);
              setDeleteInput('');
              setDeleteError(null);
            }}
          >
            Request account deletion
          </button>
        </div>
      </AccountSectionCard>

      {deleteConfirm ? (
        <AccountModal title="Delete account permanently?" onClose={() => setDeleteConfirm(false)}>
          <p className="account-modal-body">
            This revokes licenses, removes Discord roles, and schedules your data for deletion. Type{' '}
            <strong>DELETE</strong> to confirm.
          </p>
          <input
            ref={deleteInputRef}
            type="text"
            className="account-modal-input"
            placeholder="DELETE"
            value={deleteInput}
            onChange={(event) => setDeleteInput(event.target.value)}
            disabled={deleteMut.isPending}
          />
          {deleteError ? <p className="account-inline-error">{deleteError}</p> : null}
          <div className="account-modal-actions">
            <button
              type="button"
              className="account-btn account-btn--secondary"
              onClick={() => setDeleteConfirm(false)}
              disabled={deleteMut.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`account-btn account-btn--danger${deleteMut.isPending ? ' btn-loading' : ''}`}
              onClick={() => deleteMut.mutate()}
              disabled={!canDelete || deleteMut.isPending}
            >
              {deleteMut.isPending ? (
                <>
                  <span className="btn-loading-spinner" aria-hidden="true" />
                  Submitting...
                </>
              ) : (
                'Delete my account'
              )}
            </button>
          </div>
        </AccountModal>
      ) : null}
    </AccountPage>
  );
}
