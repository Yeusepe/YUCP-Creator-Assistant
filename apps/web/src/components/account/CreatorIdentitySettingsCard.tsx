import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AccountInlineError, AccountSectionCard } from '@/components/account/AccountPage';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { YucpButton } from '@/components/ui/YucpButton';
import { YucpInput } from '@/components/ui/YucpInput';
import { type CreatorIdentity, getCreatorIdentity, updateCreatorIdentity } from '@/lib/dashboard';

const EMPTY_IDENTITY: CreatorIdentity = {
  deliverySlug: '',
  name: '',
  privateVpmHostname: null,
  publicSlug: '',
};

export function CreatorIdentitySettingsCard() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [identityDraft, setIdentityDraft] = useState<CreatorIdentity>(EMPTY_IDENTITY);
  const identityQuery = useQuery({
    queryKey: ['creator-identity'],
    queryFn: getCreatorIdentity,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (identityQuery.data) {
      setIdentityDraft(identityQuery.data);
    }
  }, [identityQuery.data]);

  const saveIdentityMutation = useMutation({
    mutationFn: (input: { deliverySlug: string; name: string; publicSlug: string }) =>
      updateCreatorIdentity(input),
    onSuccess: async (identity) => {
      setIdentityDraft(identity);
      toast.success('Creator identity saved', {
        description: 'Your account-wide creator links now use the updated names.',
      });
      await queryClient.invalidateQueries({ queryKey: ['creator-identity'] });
    },
    onError: (error) => {
      if (identityQuery.data) {
        setIdentityDraft(identityQuery.data);
      }
      toast.error('Could not save creator identity', {
        description: error instanceof Error ? error.message : 'Check the values and try again.',
        duration: 5000,
      });
    },
  });

  const isPending = identityQuery.isLoading || saveIdentityMutation.isPending;
  const canSave =
    !isPending &&
    Boolean(
      identityDraft.name.trim() &&
        identityDraft.publicSlug.trim() &&
        identityDraft.deliverySlug.trim()
    );

  return (
    <AccountSectionCard
      className="account-identity-card bento-col-12 animate-in animate-in-delay-2"
      leading={<Icon name="link" aria-hidden />}
      eyebrow="Creator settings"
      title="Creator identity and URLs"
      description="These account-wide values apply to every package. Product cards only control each product's path."
      actions={
        <YucpButton
          yucp="primary"
          pill
          isLoading={saveIdentityMutation.isPending}
          isDisabled={!canSave}
          className="account-btn account-btn--primary"
          aria-label="Save creator identity"
          onPress={() =>
            saveIdentityMutation.mutate({
              deliverySlug: identityDraft.deliverySlug,
              name: identityDraft.name,
              publicSlug: identityDraft.publicSlug,
            })
          }
        >
          {saveIdentityMutation.isPending ? 'Saving...' : 'Save identity'}
        </YucpButton>
      }
    >
      {identityQuery.isError ? (
        <AccountInlineError
          message={
            identityQuery.error instanceof Error
              ? identityQuery.error.message
              : 'Failed to load creator identity.'
          }
        />
      ) : (
        <>
          <fieldset className="account-identity-grid" aria-busy={identityQuery.isLoading}>
            <legend className="sr-only">Creator identity fields</legend>
            <label className="account-identity-field" htmlFor="creator-display-name">
              <span className="account-identity-label">Display name</span>
              <YucpInput
                id="creator-display-name"
                aria-label="Creator display name"
                className="account-identity-input"
                value={identityDraft.name}
                isDisabled={isPending}
                onValueChange={(name) => setIdentityDraft((current) => ({ ...current, name }))}
              />
              <span className="account-identity-help">Shown to buyers and collaborators.</span>
            </label>

            <label className="account-identity-field" htmlFor="creator-public-handle">
              <span className="account-identity-label">Public creator handle</span>
              <YucpInput
                id="creator-public-handle"
                aria-label="Public creator handle"
                className="account-identity-input"
                value={identityDraft.publicSlug}
                isDisabled={isPending}
                onValueChange={(publicSlug) =>
                  setIdentityDraft((current) => ({ ...current, publicSlug }))
                }
              />
              <span className="account-identity-help">
                /get-in-unity/{identityDraft.publicSlug || 'your-handle'}/product
              </span>
            </label>

            <label className="account-identity-field" htmlFor="creator-private-vpm-subdomain">
              <span className="account-identity-label">Private VPM subdomain</span>
              <YucpInput
                id="creator-private-vpm-subdomain"
                aria-label="Private VPM subdomain"
                className="account-identity-input"
                value={identityDraft.deliverySlug}
                isDisabled={isPending}
                onValueChange={(deliverySlug) =>
                  setIdentityDraft((current) => ({ ...current, deliverySlug }))
                }
              />
              <span className="account-identity-help">
                https://{identityDraft.deliverySlug || 'your-handle'}.private.yucp.club
              </span>
            </label>
          </fieldset>
          {identityQuery.isLoading ? (
            <output className="text-foreground/55 mt-4 text-sm dark:text-foreground/55">
              Loading creator identity...
            </output>
          ) : null}
        </>
      )}
    </AccountSectionCard>
  );
}
