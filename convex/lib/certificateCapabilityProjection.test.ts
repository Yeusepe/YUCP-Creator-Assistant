import { describe, expect, it } from 'bun:test';
import { projectWorkspaceCapabilities } from './certificateCapabilityProjection';

describe('certificateCapabilityProjection', () => {
  it('projects active capabilities from the entitlement plan when stored rows are missing', () => {
    expect(
      projectWorkspaceCapabilities({
        includedCapabilityKeys: ['protected_exports', 'coupling_traceability'],
        entitlementStatus: 'active',
        storedCapabilities: [],
      })
    ).toEqual([
      { capabilityKey: 'coupling_traceability', status: 'active' },
      { capabilityKey: 'protected_exports', status: 'active' },
    ]);
  });

  it('marks stale stored capabilities inactive after a downgrade', () => {
    expect(
      projectWorkspaceCapabilities({
        includedCapabilityKeys: [],
        entitlementStatus: 'inactive',
        storedCapabilities: [{ capabilityKey: 'protected_exports', status: 'active' }],
      })
    ).toEqual([{ capabilityKey: 'protected_exports', status: 'inactive' }]);
  });

  it('uses the entitlement status for currently included capabilities', () => {
    expect(
      projectWorkspaceCapabilities({
        includedCapabilityKeys: ['protected_exports'],
        entitlementStatus: 'grace',
        storedCapabilities: [{ capabilityKey: 'protected_exports', status: 'inactive' }],
      })
    ).toEqual([{ capabilityKey: 'protected_exports', status: 'grace' }]);
  });
});
