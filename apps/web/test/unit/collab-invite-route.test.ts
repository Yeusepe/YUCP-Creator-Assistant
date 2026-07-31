import { LEGACY_CREATOR_WORKSPACE_GRANTS } from '@yucp/shared/creatorWorkspacePermissions';
import { describe, expect, it } from 'vitest';
import { Route, resolveInvitePermissionGrants } from '@/routes/collab-invite';

describe('collab invite route search normalization', () => {
  it('accepts the legacy token query parameter as the invite token', () => {
    const search = Route.options.validateSearch?.({ token: 'invite-token' });

    expect(search).toEqual({
      auth: undefined,
      t: 'invite-token',
    });
  });

  it('shows the effective legacy grants for provider-specific invitations', () => {
    expect(resolveInvitePermissionGrants({ providerKey: 'jinxxy' })).toEqual(
      LEGACY_CREATOR_WORKSPACE_GRANTS
    );
  });

  it('drops unknown capability keys instead of crashing the consent screen', () => {
    expect(
      resolveInvitePermissionGrants({
        permissionGrants: [
          {
            capabilityKey: 'packages.removed-capability',
            resourceType: 'package',
            scope: 'all',
          },
        ],
      })
    ).toEqual([]);
  });
});
