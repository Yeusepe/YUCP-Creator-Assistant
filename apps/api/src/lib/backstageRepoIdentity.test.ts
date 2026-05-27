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
