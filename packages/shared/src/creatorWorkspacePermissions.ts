export const CREATOR_WORKSPACE_POLICY_VERSION = 1 as const;

export const CREATOR_WORKSPACE_RESOURCE_TYPES = [
  'workspace',
  'product',
  'package',
  'guild',
  'provider_connection',
  'developer_integration',
] as const;

export type CreatorWorkspaceResourceType = (typeof CREATOR_WORKSPACE_RESOURCE_TYPES)[number];
export type CreatorWorkspaceGrantScope = 'all' | 'selected';

export type CreatorWorkspaceGrant = {
  capabilityKey: CreatorWorkspaceCapabilityKey;
  resourceType: CreatorWorkspaceResourceType;
  scope: CreatorWorkspaceGrantScope;
  resourceId?: string;
};

export type CreatorWorkspaceCapabilityDefinition = {
  description: string;
  group:
    | 'products'
    | 'packages'
    | 'stores_and_servers'
    | 'developer_integrations'
    | 'collaboration';
  label: string;
  resourceTypes: readonly CreatorWorkspaceResourceType[];
  sensitive?: boolean;
};

export const CREATOR_WORKSPACE_CAPABILITIES = {
  'products.view': {
    description: 'View product names, storefront metadata, and package bindings.',
    group: 'products',
    label: 'View products',
    resourceTypes: ['product'],
  },
  'products.manage': {
    description: 'Edit product configuration and package bindings.',
    group: 'products',
    label: 'Manage products',
    resourceTypes: ['product'],
  },
  'products.buyers.view': {
    description: 'View buyer, entitlement, and license verification information.',
    group: 'products',
    label: 'View buyers and verification data',
    resourceTypes: ['product'],
    sensitive: true,
  },
  'products.verification_rules.manage': {
    description: 'Create and edit verification and role rules for products and servers.',
    group: 'products',
    label: 'Manage verification rules',
    resourceTypes: ['product', 'guild'],
  },
  'packages.view': {
    description: 'View package metadata, editions, and release history.',
    group: 'packages',
    label: 'View packages',
    resourceTypes: ['package'],
  },
  'packages.create': {
    description: 'Create package identities for the selected products.',
    group: 'packages',
    label: 'Create packages',
    resourceTypes: ['product'],
  },
  'packages.releases.upload': {
    description: 'Upload new package releases.',
    group: 'packages',
    label: 'Upload releases',
    resourceTypes: ['package'],
  },
  'packages.releases.delete': {
    description: 'Permanently remove package releases.',
    group: 'packages',
    label: 'Delete releases',
    resourceTypes: ['package'],
    sensitive: true,
  },
  'packages.editions.manage': {
    description: 'Create, edit, archive, and restore package editions.',
    group: 'packages',
    label: 'Manage editions',
    resourceTypes: ['package'],
  },
  'packages.storefront_bindings.manage': {
    description: 'Link or unlink storefront products from packages.',
    group: 'packages',
    label: 'Manage storefront bindings',
    resourceTypes: ['package', 'product'],
  },
  'packages.unity_access.manage': {
    description: 'Enable or disable Unity access and manage the Unity package name.',
    group: 'packages',
    label: 'Manage Unity access',
    resourceTypes: ['package'],
  },
  'packages.public_links.manage': {
    description: 'Create, rename, or revoke public package links.',
    group: 'packages',
    label: 'Manage public links',
    resourceTypes: ['package'],
  },
  'packages.bootstraps.download': {
    description: 'Generate and download VPM or Unitypackage bootstraps.',
    group: 'packages',
    label: 'Download bootstraps',
    resourceTypes: ['package'],
  },
  'packages.forensics.view': {
    description: 'View package coupling and forensic information.',
    group: 'packages',
    label: 'View package forensics',
    resourceTypes: ['package'],
    sensitive: true,
  },
  'stores.view': {
    description: 'View connected store metadata without revealing credentials.',
    group: 'stores_and_servers',
    label: 'View connected stores',
    resourceTypes: ['provider_connection'],
  },
  'stores.manage': {
    description: 'Connect, update, and disconnect store integrations.',
    group: 'stores_and_servers',
    label: 'Manage connected stores',
    resourceTypes: ['provider_connection'],
    sensitive: true,
  },
  'servers.view': {
    description: 'View Discord server configuration.',
    group: 'stores_and_servers',
    label: 'View servers',
    resourceTypes: ['guild'],
  },
  'servers.settings.manage': {
    description: 'Change Discord server and verification settings.',
    group: 'stores_and_servers',
    label: 'Manage server settings',
    resourceTypes: ['guild'],
  },
  'developer.integrations.view': {
    description: 'View OAuth applications, API key metadata, and webhooks.',
    group: 'developer_integrations',
    label: 'View developer integrations',
    resourceTypes: ['developer_integration'],
  },
  'developer.integrations.manage': {
    description: 'Create, update, and revoke developer integrations.',
    group: 'developer_integrations',
    label: 'Manage developer integrations',
    resourceTypes: ['developer_integration'],
    sensitive: true,
  },
  'developer.secrets.manage': {
    description: 'Create or reveal sensitive API and OAuth credentials.',
    group: 'developer_integrations',
    label: 'Manage integration secrets',
    resourceTypes: ['developer_integration'],
    sensitive: true,
  },
  'developer.api_keys.create': {
    description: 'Create public API keys for the creator workspace.',
    group: 'developer_integrations',
    label: 'Create API keys',
    resourceTypes: ['workspace'],
    sensitive: true,
  },
  'collaborators.view': {
    description: 'View collaborators and their effective access.',
    group: 'collaboration',
    label: 'View collaborators',
    resourceTypes: ['workspace'],
  },
  'collaborators.invites.manage': {
    description: 'Create and revoke collaborator invitations.',
    group: 'collaboration',
    label: 'Manage invitations',
    resourceTypes: ['workspace'],
    sensitive: true,
  },
  'collaborators.permissions.manage': {
    description: 'Change collaborator permissions without granting more than you possess.',
    group: 'collaboration',
    label: 'Manage permissions',
    resourceTypes: ['workspace'],
    sensitive: true,
  },
  'collaborators.remove': {
    description: 'Remove collaborators from the creator workspace.',
    group: 'collaboration',
    label: 'Remove collaborators',
    resourceTypes: ['workspace'],
    sensitive: true,
  },
} as const satisfies Record<string, CreatorWorkspaceCapabilityDefinition>;

export type CreatorWorkspaceCapabilityKey = keyof typeof CREATOR_WORKSPACE_CAPABILITIES;

const LEGACY_CAPABILITY_KEYS = [
  'products.view',
  'products.manage',
  'packages.view',
  'packages.create',
  'packages.releases.upload',
  'packages.releases.delete',
  'packages.editions.manage',
  'packages.storefront_bindings.manage',
  'packages.unity_access.manage',
  'packages.public_links.manage',
  'packages.bootstraps.download',
  'packages.forensics.view',
] as const satisfies readonly CreatorWorkspaceCapabilityKey[];

export const LEGACY_CREATOR_WORKSPACE_GRANTS: readonly CreatorWorkspaceGrant[] =
  LEGACY_CAPABILITY_KEYS.flatMap((capabilityKey) =>
    CREATOR_WORKSPACE_CAPABILITIES[capabilityKey].resourceTypes.map((resourceType) => ({
      capabilityKey,
      resourceType,
      scope: 'all' as const,
    }))
  );

function isCapabilityKey(value: string): value is CreatorWorkspaceCapabilityKey {
  return Object.hasOwn(CREATOR_WORKSPACE_CAPABILITIES, value);
}

function isResourceType(value: string): value is CreatorWorkspaceResourceType {
  return (CREATOR_WORKSPACE_RESOURCE_TYPES as readonly string[]).includes(value);
}

export function normalizeCreatorWorkspaceGrants(
  grants: readonly {
    capabilityKey: string;
    resourceId?: string;
    resourceType: string;
    scope: string;
  }[]
): CreatorWorkspaceGrant[] {
  const normalized = new Map<string, CreatorWorkspaceGrant>();
  for (const input of grants) {
    if (!isCapabilityKey(input.capabilityKey)) {
      throw new Error(`Unknown creator workspace capability: ${input.capabilityKey}`);
    }
    if (!isResourceType(input.resourceType)) {
      throw new Error(`Unknown creator workspace resource type: ${input.resourceType}`);
    }
    if (
      !CREATOR_WORKSPACE_CAPABILITIES[input.capabilityKey].resourceTypes.includes(
        input.resourceType as never
      )
    ) {
      throw new Error(`${input.capabilityKey} cannot be scoped to ${input.resourceType}`);
    }
    if (input.scope !== 'all' && input.scope !== 'selected') {
      throw new Error(`Unknown creator workspace grant scope: ${input.scope}`);
    }
    const resourceId = input.resourceId?.trim();
    if (input.scope === 'all' && resourceId) {
      throw new Error('All-resource grants cannot include a resource ID');
    }
    if (input.scope === 'selected' && !resourceId) {
      throw new Error('Selected-resource grants require a resource ID');
    }
    const grant: CreatorWorkspaceGrant = {
      capabilityKey: input.capabilityKey,
      resourceType: input.resourceType,
      scope: input.scope,
      ...(resourceId ? { resourceId } : {}),
    };
    normalized.set(
      `${grant.capabilityKey}\u0000${grant.resourceType}\u0000${grant.scope}\u0000${resourceId ?? ''}`,
      grant
    );
  }
  return [...normalized.values()].sort((left, right) => {
    return (
      left.capabilityKey.localeCompare(right.capabilityKey) ||
      left.resourceType.localeCompare(right.resourceType) ||
      left.scope.localeCompare(right.scope) ||
      (left.resourceId ?? '').localeCompare(right.resourceId ?? '')
    );
  });
}
