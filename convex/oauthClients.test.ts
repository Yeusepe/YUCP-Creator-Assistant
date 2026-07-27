import { describe, expect, it } from 'bun:test';
import { selectClientIdsNeedingPublicApiLink } from './oauthClients';
import { getPackageBrokerOAuthClientDescriptors } from './seedYucpOAuthClient';

describe('selectClientIdsNeedingPublicApiLink', () => {
  it('links creator-registered clients so they can exchange a code', () => {
    expect(selectClientIdsNeedingPublicApiLink(['creator-app-a', 'creator-app-b'])).toEqual([
      'creator-app-a',
      'creator-app-b',
    ]);
  });

  it('never links a seeded native client to the public API resource', () => {
    const seeded = getPackageBrokerOAuthClientDescriptors().map(
      (descriptor) => descriptor.clientId
    );

    expect(selectClientIdsNeedingPublicApiLink([...seeded, 'creator-app'])).toEqual([
      'creator-app',
    ]);
  });

  it('ignores blank ids and collapses duplicates', () => {
    expect(
      selectClientIdsNeedingPublicApiLink(['creator-app', 'creator-app', '', null, undefined])
    ).toEqual(['creator-app']);
  });
});
