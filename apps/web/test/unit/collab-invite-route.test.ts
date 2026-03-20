import { describe, expect, it } from 'vitest';
import { Route } from '@/routes/collab-invite';

describe('collab invite route search normalization', () => {
  it('accepts the legacy token query parameter as the invite token', () => {
    const search = Route.options.validateSearch?.({ token: 'invite-token' });

    expect(search).toEqual({
      auth: undefined,
      t: 'invite-token',
    });
  });
});
