import { describe, expect, it } from 'bun:test';
import {
  CREATOR_WORKSPACE_CAPABILITIES,
  LEGACY_CREATOR_WORKSPACE_GRANTS,
  normalizeCreatorWorkspaceGrants,
} from './creatorWorkspacePermissions';

describe('creator workspace permissions', () => {
  it('keeps product visibility and package uploads independently assignable', () => {
    expect(CREATOR_WORKSPACE_CAPABILITIES['products.view'].resourceTypes).toEqual(['product']);
    expect(CREATOR_WORKSPACE_CAPABILITIES['packages.releases.upload'].resourceTypes).toEqual([
      'package',
    ]);
  });

  it('normalizes selected resources without widening them to all resources', () => {
    expect(
      normalizeCreatorWorkspaceGrants([
        {
          capabilityKey: 'products.view',
          resourceId: 'product-b',
          resourceType: 'product',
          scope: 'selected',
        },
        {
          capabilityKey: 'products.view',
          resourceId: 'product-a',
          resourceType: 'product',
          scope: 'selected',
        },
        {
          capabilityKey: 'products.view',
          resourceId: 'product-a',
          resourceType: 'product',
          scope: 'selected',
        },
      ])
    ).toEqual([
      {
        capabilityKey: 'products.view',
        resourceId: 'product-a',
        resourceType: 'product',
        scope: 'selected',
      },
      {
        capabilityKey: 'products.view',
        resourceId: 'product-b',
        resourceType: 'product',
        scope: 'selected',
      },
    ]);
  });

  it('rejects invalid resource axes and ambiguous all-resource grants', () => {
    expect(() =>
      normalizeCreatorWorkspaceGrants([
        {
          capabilityKey: 'products.view',
          resourceType: 'package',
          scope: 'all',
        },
      ])
    ).toThrow('products.view cannot be scoped to package');
    expect(() =>
      normalizeCreatorWorkspaceGrants([
        {
          capabilityKey: 'products.view',
          resourceId: 'product-a',
          resourceType: 'product',
          scope: 'all',
        },
      ])
    ).toThrow('All-resource grants cannot include a resource ID');
  });

  it('migrates only the package access that legacy collaborators already receive', () => {
    expect(LEGACY_CREATOR_WORKSPACE_GRANTS).toEqual(
      expect.arrayContaining([
        {
          capabilityKey: 'products.view',
          resourceType: 'product',
          scope: 'all',
        },
        {
          capabilityKey: 'packages.releases.upload',
          resourceType: 'package',
          scope: 'all',
        },
      ])
    );
    expect(
      LEGACY_CREATOR_WORKSPACE_GRANTS.some(
        (grant) => grant.capabilityKey === 'developer.api_keys.create'
      )
    ).toBe(false);
    expect(
      LEGACY_CREATOR_WORKSPACE_GRANTS.some(
        (grant) => grant.capabilityKey === 'collaborators.permissions.manage'
      )
    ).toBe(false);
  });
});
