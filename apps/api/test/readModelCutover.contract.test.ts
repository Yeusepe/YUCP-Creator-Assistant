import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..', '..');
const connectSource = readFileSync(
  join(repoRoot, 'apps', 'api', 'src', 'routes', 'connect.ts'),
  'utf8'
);
const collabSource = readFileSync(
  join(repoRoot, 'apps', 'api', 'src', 'routes', 'collab.ts'),
  'utf8'
);
const publicCollaboratorsSource = readFileSync(
  join(repoRoot, 'apps', 'api', 'src', 'routes', 'publicV2', 'collaborators.ts'),
  'utf8'
);
const dashboardViewsSource = readFileSync(join(repoRoot, 'convex', 'dashboardViews.ts'), 'utf8');
const productResolutionSource = readFileSync(
  join(repoRoot, 'convex', 'productResolution.ts'),
  'utf8'
);

describe('interactive read-model contracts', () => {
  it('keeps provider account and status routes backed by Convex provider connection read models', () => {
    expect(connectSource).toContain('api.providerConnections.listConnectionsForUser');
    expect(connectSource).toContain('api.providerConnections.getConnectionStatus');
  });

  it('keeps collaborator routes backed by collaborator read models instead of provider plugins', () => {
    expect(collabSource).toContain('api.collaboratorInvites.listCollaboratorConnections');
    expect(collabSource).toContain('api.collaboratorInvites.listConnectionsAsCollaborator');
    expect(publicCollaboratorsSource).toContain('api.collaboratorInvites.listConnectionsByOwner');
    expect(publicCollaboratorsSource).toContain('api.collaboratorInvites.getConnectionById');
  });

  it('exposes freshness metadata on provider and configured product read models', () => {
    expect(dashboardViewsSource).toContain('lastSyncAt: c.lastSyncAt');
    expect(dashboardViewsSource).toContain('lastWebhookAt: c.lastWebhookAt');
    expect(productResolutionSource).toContain(".query('provider_catalog_mappings')");
    expect(productResolutionSource).toContain('lastSyncedAt:');
  });
});
