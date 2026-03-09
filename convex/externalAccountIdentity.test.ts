import { describe, expect, it } from 'bun:test';
import {
  findDuplicateExternalAccountIdentityGroups,
  selectCanonicalExternalAccountCandidates,
} from './lib/externalAccountIdentity';

describe('external account identity helpers', () => {
  it('keeps only the earliest record for the same provider identity', () => {
    const canonical = selectCanonicalExternalAccountCandidates([
      {
        bindingCreatedAt: 300,
        bindingId: 'binding_2',
        externalAccountCreatedAt: 200,
        externalAccountCreationTime: 200,
        externalAccountId: 'account_2',
        provider: 'gumroad',
        providerUserId: 'gumroad_user',
      },
      {
        bindingCreatedAt: 100,
        bindingId: 'binding_1',
        externalAccountCreatedAt: 100,
        externalAccountCreationTime: 100,
        externalAccountId: 'account_1',
        provider: 'gumroad',
        providerUserId: 'gumroad_user',
      },
    ]);

    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.externalAccountId).toBe('account_1');
  });

  it('preserves distinct accounts from the same provider', () => {
    const canonical = selectCanonicalExternalAccountCandidates([
      {
        bindingCreatedAt: 100,
        bindingId: 'binding_1',
        externalAccountCreatedAt: 100,
        externalAccountCreationTime: 100,
        externalAccountId: 'account_1',
        provider: 'gumroad',
        providerUserId: 'gumroad_user_1',
      },
      {
        bindingCreatedAt: 200,
        bindingId: 'binding_2',
        externalAccountCreatedAt: 200,
        externalAccountCreationTime: 200,
        externalAccountId: 'account_2',
        provider: 'gumroad',
        providerUserId: 'gumroad_user_2',
      },
    ]);

    expect(canonical).toHaveLength(2);
    expect(canonical.map((candidate) => candidate.externalAccountId)).toEqual([
      'account_1',
      'account_2',
    ]);
  });

  it('reports the extra records that should be removed', () => {
    const duplicates = findDuplicateExternalAccountIdentityGroups([
      {
        bindingCreatedAt: 100,
        bindingId: 'binding_1',
        externalAccountCreatedAt: 100,
        externalAccountCreationTime: 100,
        externalAccountId: 'account_1',
        provider: 'gumroad',
        providerUserId: 'same_user',
      },
      {
        bindingCreatedAt: 200,
        bindingId: 'binding_2',
        externalAccountCreatedAt: 200,
        externalAccountCreationTime: 200,
        externalAccountId: 'account_2',
        provider: 'gumroad',
        providerUserId: 'same_user',
      },
      {
        bindingCreatedAt: 300,
        bindingId: 'binding_3',
        externalAccountCreatedAt: 300,
        externalAccountCreationTime: 300,
        externalAccountId: 'account_3',
        provider: 'gumroad',
        providerUserId: 'other_user',
      },
    ]);

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.keep.externalAccountId).toBe('account_1');
    expect(duplicates[0]?.duplicates.map((candidate) => candidate.externalAccountId)).toEqual([
      'account_2',
    ]);
  });
});
