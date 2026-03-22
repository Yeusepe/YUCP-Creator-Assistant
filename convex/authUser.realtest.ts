import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const authViewerSource = readFileSync(resolve(__dirname, './authViewer.ts'), 'utf8');
const dashboardViewsSource = readFileSync(resolve(__dirname, './dashboardViews.ts'), 'utf8');
const adminNotificationsSource = readFileSync(resolve(__dirname, './adminNotifications.ts'), 'utf8');

describe('dashboard Better Auth user resolution contracts', () => {
  it('uses a shared authenticated-user resolver instead of calling authComponent.getAuthUser directly', () => {
    for (const source of [authViewerSource, dashboardViewsSource, adminNotificationsSource]) {
      expect(source).toContain('getAuthenticatedAuthUser');
      expect(source).not.toContain('authComponent.getAuthUser(ctx)');
    }
  });

  it('avoids direct authUser.id access in dashboard-facing Better Auth queries', () => {
    for (const source of [authViewerSource, dashboardViewsSource, adminNotificationsSource]) {
      expect(source).not.toContain('authUser.id');
    }
  });
});
