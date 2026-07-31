import { Button, Chip, Switch } from '@heroui/react';
import { ItemCard } from '@heroui-pro/react/item-card';
import { ItemCardGroup } from '@heroui-pro/react/item-card-group';
import { ListView } from '@heroui-pro/react/list-view';
import { Segment } from '@heroui-pro/react/segment';
import { Sheet } from '@heroui-pro/react/sheet';
import {
  CREATOR_WORKSPACE_CAPABILITIES,
  type CreatorWorkspaceCapabilityKey,
  type CreatorWorkspaceGrant,
  type CreatorWorkspaceResourceType,
  normalizeCreatorWorkspaceGrants,
} from '@yucp/shared/creatorWorkspacePermissions';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { YucpButton } from '@/components/ui/YucpButton';

export interface CollaboratorPermissionResource {
  description?: string;
  id: string;
  label: string;
  type: CreatorWorkspaceResourceType;
}

const ASSIGNABLE_CAPABILITIES = (
  Object.keys(CREATOR_WORKSPACE_CAPABILITIES) as CreatorWorkspaceCapabilityKey[]
).filter((key) => {
  const group = CREATOR_WORKSPACE_CAPABILITIES[key].group;
  return group === 'products' || group === 'packages';
});

const GROUP_LABELS = {
  products: 'Products',
  packages: 'Packages',
} as const;

function grantsForAxis(
  grants: readonly CreatorWorkspaceGrant[],
  capabilityKey: CreatorWorkspaceCapabilityKey,
  resourceType: CreatorWorkspaceResourceType
) {
  return grants.filter(
    (grant) => grant.capabilityKey === capabilityKey && grant.resourceType === resourceType
  );
}

export function CollaboratorPermissionSheet({
  description,
  actionError,
  initialGrants,
  isOpen,
  isSaving,
  legacyPolicyPendingReview = false,
  onOpenChange,
  onSave,
  resources,
  title,
}: {
  description: string;
  actionError?: string | null;
  initialGrants: readonly CreatorWorkspaceGrant[];
  isOpen: boolean;
  isSaving: boolean;
  legacyPolicyPendingReview?: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (grants: CreatorWorkspaceGrant[]) => void;
  resources: readonly CollaboratorPermissionResource[];
  title: string;
}) {
  const [grants, setGrants] = useState<CreatorWorkspaceGrant[]>([]);
  const [enabledCapabilities, setEnabledCapabilities] = useState<
    Set<CreatorWorkspaceCapabilityKey>
  >(new Set());
  const [validationError, setValidationError] = useState<string | null>(null);
  const initialGrantsRef = useRef(initialGrants);
  initialGrantsRef.current = initialGrants;

  useEffect(() => {
    if (isOpen) {
      const normalized = normalizeCreatorWorkspaceGrants(initialGrantsRef.current);
      setGrants(normalized);
      setEnabledCapabilities(new Set(normalized.map((grant) => grant.capabilityKey)));
      setValidationError(null);
    }
  }, [isOpen]);

  const resourceMap = useMemo(() => {
    const map = new Map<CreatorWorkspaceResourceType, CollaboratorPermissionResource[]>();
    for (const resource of resources) {
      const current = map.get(resource.type) ?? [];
      current.push(resource);
      map.set(resource.type, current);
    }
    for (const entries of map.values()) {
      entries.sort((left, right) => left.label.localeCompare(right.label));
    }
    return map;
  }, [resources]);

  const updateCapabilityEnabled = (
    capabilityKey: CreatorWorkspaceCapabilityKey,
    enabled: boolean
  ) => {
    const definition = CREATOR_WORKSPACE_CAPABILITIES[capabilityKey];
    setEnabledCapabilities((current) => {
      const next = new Set(current);
      if (enabled) {
        next.add(capabilityKey);
      } else {
        next.delete(capabilityKey);
      }
      return next;
    });
    setGrants((current) => {
      const withoutCapability = current.filter((grant) => grant.capabilityKey !== capabilityKey);
      if (!enabled) return withoutCapability;
      return normalizeCreatorWorkspaceGrants([
        ...withoutCapability,
        ...definition.resourceTypes.map((resourceType) => ({
          capabilityKey,
          resourceType,
          scope: 'all' as const,
        })),
      ]);
    });
  };

  const updateScope = (
    capabilityKey: CreatorWorkspaceCapabilityKey,
    resourceType: CreatorWorkspaceResourceType,
    scope: 'all' | 'selected'
  ) => {
    setGrants((current) => {
      const others = current.filter(
        (grant) => grant.capabilityKey !== capabilityKey || grant.resourceType !== resourceType
      );
      return normalizeCreatorWorkspaceGrants([
        ...others,
        ...(scope === 'all' ? [{ capabilityKey, resourceType, scope: 'all' as const }] : []),
      ]);
    });
  };

  const updateSelectedResources = (
    capabilityKey: CreatorWorkspaceCapabilityKey,
    resourceType: CreatorWorkspaceResourceType,
    selectedIds: string[]
  ) => {
    setGrants((current) =>
      normalizeCreatorWorkspaceGrants([
        ...current.filter(
          (grant) => grant.capabilityKey !== capabilityKey || grant.resourceType !== resourceType
        ),
        ...selectedIds.map((resourceId) => ({
          capabilityKey,
          resourceId,
          resourceType,
          scope: 'selected' as const,
        })),
      ])
    );
  };

  const save = () => {
    try {
      setValidationError(null);
      for (const capabilityKey of enabledCapabilities) {
        const definition = CREATOR_WORKSPACE_CAPABILITIES[capabilityKey];
        for (const resourceType of definition.resourceTypes) {
          if (grantsForAxis(grants, capabilityKey, resourceType).length === 0) {
            throw new Error(
              `Choose at least one ${resourceType.replaceAll('_', ' ')} for ${definition.label}, or turn the capability off.`
            );
          }
        }
      }
      onSave(normalizeCreatorWorkspaceGrants(grants));
    } catch (error) {
      setValidationError(
        error instanceof Error ? error.message : 'The permission policy is invalid.'
      );
    }
  };

  return (
    <Sheet isOpen={isOpen} onOpenChange={onOpenChange} placement="right">
      <Sheet.Backdrop variant="blur">
        <Sheet.Content>
          <Sheet.Dialog className="w-full sm:max-w-2xl">
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>{title}</Sheet.Heading>
              <p className="text-sm text-muted dark:text-muted">{description}</p>
            </Sheet.Header>
            <Sheet.Body className="space-y-5 px-5 pb-[calc(2rem+env(safe-area-inset-bottom))]">
              {legacyPolicyPendingReview ? (
                <div className="rounded-2xl border border-warning/25 bg-warning-soft p-4 text-sm text-warning-foreground dark:border-warning/35 dark:bg-warning-soft dark:text-warning-foreground">
                  This collaborator has migrated legacy permissions. Review every capability before
                  saving.
                </div>
              ) : null}
              {actionError ? (
                <div
                  role="alert"
                  className="rounded-2xl border border-danger/25 bg-danger-soft p-4 text-sm text-danger dark:border-danger/35 dark:bg-danger-soft dark:text-danger"
                >
                  {actionError}
                </div>
              ) : null}

              {(['products', 'packages'] as const).map((group) => {
                const capabilities = ASSIGNABLE_CAPABILITIES.filter(
                  (key) => CREATOR_WORKSPACE_CAPABILITIES[key].group === group
                );
                return (
                  <ItemCardGroup key={group} variant="outline">
                    <ItemCardGroup.Header>
                      <ItemCardGroup.Title>{GROUP_LABELS[group]}</ItemCardGroup.Title>
                      <ItemCardGroup.Description>
                        Each capability has its own independent resource scope.
                      </ItemCardGroup.Description>
                    </ItemCardGroup.Header>
                    {capabilities.map((capabilityKey) => {
                      const definition = CREATOR_WORKSPACE_CAPABILITIES[capabilityKey];
                      const enabled = enabledCapabilities.has(capabilityKey);
                      return (
                        <ItemCard key={capabilityKey} variant="transparent">
                          <ItemCard.Content>
                            <div>
                              <ItemCard.Title>{definition.label}</ItemCard.Title>
                              <ItemCard.Description>{definition.description}</ItemCard.Description>
                            </div>

                            {enabled
                              ? definition.resourceTypes.map((resourceType) => {
                                  const axisGrants = grantsForAxis(
                                    grants,
                                    capabilityKey,
                                    resourceType
                                  );
                                  const scope = axisGrants.some((grant) => grant.scope === 'all')
                                    ? 'all'
                                    : 'selected';
                                  const options = resourceMap.get(resourceType) ?? [];
                                  const selectedIds = new Set(
                                    axisGrants
                                      .filter(
                                        (grant) => grant.scope === 'selected' && grant.resourceId
                                      )
                                      .map((grant) => grant.resourceId as string)
                                  );
                                  return (
                                    <div
                                      key={resourceType}
                                      className="mt-3 rounded-xl border border-default/40 bg-surface-secondary p-3 dark:border-default/50 dark:bg-surface-secondary"
                                    >
                                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                        <span className="text-xs font-semibold capitalize text-foreground dark:text-foreground">
                                          {resourceType.replaceAll('_', ' ')} scope
                                        </span>
                                        <Segment
                                          size="sm"
                                          aria-label={`${definition.label} ${resourceType.replaceAll('_', ' ')} scope`}
                                          selectedKey={scope}
                                          onSelectionChange={(key) =>
                                            updateScope(
                                              capabilityKey,
                                              resourceType,
                                              key === 'selected' ? 'selected' : 'all'
                                            )
                                          }
                                        >
                                          <Segment.Item id="all">All</Segment.Item>
                                          <Segment.Item id="selected">Selected</Segment.Item>
                                        </Segment>
                                      </div>
                                      {scope === 'all' ? (
                                        <p className="text-xs text-muted dark:text-muted">
                                          Includes resources created in the future.
                                        </p>
                                      ) : options.length > 0 ? (
                                        <ListView
                                          aria-label={`${definition.label} selected ${resourceType}s`}
                                          items={options}
                                          selectionMode="multiple"
                                          selectedKeys={selectedIds}
                                          onSelectionChange={(selection) =>
                                            updateSelectedResources(
                                              capabilityKey,
                                              resourceType,
                                              selection === 'all'
                                                ? options.map((option) => option.id)
                                                : [...selection].map(String)
                                            )
                                          }
                                          variant="secondary"
                                        >
                                          {(resource) => (
                                            <ListView.Item
                                              id={resource.id}
                                              textValue={resource.label}
                                            >
                                              <ListView.ItemContent>
                                                <div>
                                                  <ListView.Title>{resource.label}</ListView.Title>
                                                  {resource.description ? (
                                                    <ListView.Description>
                                                      {resource.description}
                                                    </ListView.Description>
                                                  ) : null}
                                                </div>
                                              </ListView.ItemContent>
                                            </ListView.Item>
                                          )}
                                        </ListView>
                                      ) : (
                                        <p className="text-xs text-muted dark:text-muted">
                                          No selectable resources are available for this scope.
                                        </p>
                                      )}
                                    </div>
                                  );
                                })
                              : null}
                          </ItemCard.Content>
                          <ItemCard.Action>
                            <Switch
                              aria-label={`${definition.label} permission`}
                              isSelected={enabled}
                              onChange={(next) => updateCapabilityEnabled(capabilityKey, next)}
                            >
                              <Switch.Content aria-label={`${definition.label} permission`}>
                                <Switch.Control>
                                  <Switch.Thumb />
                                </Switch.Control>
                              </Switch.Content>
                            </Switch>
                          </ItemCard.Action>
                        </ItemCard>
                      );
                    })}
                  </ItemCardGroup>
                );
              })}

              <div className="flex flex-wrap gap-2">
                <Chip variant="secondary">{grants.length} explicit grants</Chip>
                {grants.length === 0 ? (
                  <Chip
                    variant="soft"
                    className="bg-warning-soft text-warning-foreground dark:bg-warning-soft dark:text-warning-foreground"
                  >
                    No workspace access
                  </Chip>
                ) : null}
              </div>
              {validationError ? (
                <p role="alert" className="text-sm text-danger dark:text-danger">
                  {validationError}
                </p>
              ) : null}
            </Sheet.Body>
            <Sheet.Footer className="border-t border-default/30 px-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-4 dark:border-default/40">
              <Button variant="tertiary" onPress={() => onOpenChange(false)}>
                Cancel
              </Button>
              <YucpButton isLoading={isSaving} onPress={save}>
                <Icon name="check" size={15} />
                {isSaving ? 'Saving permissions...' : 'Save permissions'}
              </YucpButton>
            </Sheet.Footer>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  );
}
