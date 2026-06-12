import { expect, it, mock } from 'bun:test';

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    authViewer: {
      getViewerByAuthUser: 'authViewer.getViewerByAuthUser',
    },
    creatorProfiles: {
      getCreatorByAuthUser: 'creatorProfiles.getCreatorByAuthUser',
    },
  },
}));

const { buildCreatorRepoRef } = await import('./backstageRepoIdentity');

it('rejects blank auth user ids before deriving creator repo refs', () => {
  expect(() => buildCreatorRepoRef({ authUserId: '   ' })).toThrow('authUserId is required');
});

it('falls back to the auth user id when a creator slug has no repository id segment', () => {
  expect(buildCreatorRepoRef({ authUserId: 'auth-user-1', creatorSlug: '---' })).toBe(
    'auth-user-1'
  );
  expect(buildCreatorRepoRef({ authUserId: 'auth-user-1', creatorSlug: '✨✨' })).toBe(
    'auth-user-1'
  );
});
