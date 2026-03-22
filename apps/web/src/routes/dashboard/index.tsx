import { createFileRoute } from '@tanstack/react-router';
import { useMutation as useConvexMutation, useQuery as useConvexQuery } from 'convex/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DashboardAuthRequiredState } from '@/components/dashboard/AuthRequiredState';
import { ConnectedPlatformsPanel } from '@/components/dashboard/panels/ConnectedPlatformsPanel';
import { DangerZonePanel } from '@/components/dashboard/panels/DangerZonePanel';
import {
  OnboardingProgressPanel,
  type OnboardingStep,
} from '@/components/dashboard/panels/OnboardingProgressPanel';
import { RecentActivityPanel } from '@/components/dashboard/panels/RecentActivityPanel';
import { ServerSettingsPanel } from '@/components/dashboard/panels/ServerSettingsPanel';
import { StatsOverviewPanel } from '@/components/dashboard/panels/StatsOverviewPanel';
import { StoreIntegrationsPanel } from '@/components/dashboard/panels/StoreIntegrationsPanel';
import { useToast } from '@/components/ui/Toast';
import { useActiveDashboardContext } from '@/hooks/useActiveDashboardContext';
import { useDashboardSession } from '@/hooks/useDashboardSession';
import { useDashboardShell } from '@/hooks/useDashboardShell';
import { api } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';

export const Route = createFileRoute('/dashboard/')({
  component: DashboardIndex,
});

const ONBOARDING_DISMISSED_KEY = 'yucp_onboarding_dismissed';
const ONBOARDING_STATE_KEY = 'yucp_onboarding_state';

interface OnboardingState {
  docsRead: boolean;
}

function readOnboardingState(): OnboardingState {
  if (typeof window === 'undefined') {
    return { docsRead: false };
  }

  try {
    const raw = localStorage.getItem(ONBOARDING_STATE_KEY);
    if (!raw) {
      return { docsRead: false };
    }

    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    return {
      docsRead: parsed.docsRead === true,
    };
  } catch {
    return { docsRead: false };
  }
}

function DashboardIndex() {
  const { isPersonalDashboard, activeGuildId, activeTenantId } = useActiveDashboardContext();
  const { canRunPanelQueries, status } = useDashboardSession();
  const { guilds } = useDashboardShell();
  const toast = useToast();

  // Admin notifications (Convex real-time)
  const adminNotifications = useConvexQuery(api.adminNotifications.listUnseen) ?? [];
  const markSeenMutation = useConvexMutation(api.adminNotifications.markSeen);
  const seenNotificationIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unseen = adminNotifications.filter(
      (n: { _id: Id<'admin_notifications'>; type: string; title: string; message?: string }) =>
        !seenNotificationIds.current.has(n._id)
    );
    if (unseen.length === 0) return;

    const ids = unseen.map((n: { _id: Id<'admin_notifications'> }) => n._id);
    for (const id of ids) {
      seenNotificationIds.current.add(id);
    }

    for (const n of unseen as Array<{
      _id: Id<'admin_notifications'>;
      type: 'success' | 'error' | 'warning' | 'info';
      title: string;
      message?: string;
    }>) {
      const opts = n.message ? { description: n.message } : undefined;
      if (n.type === 'success') toast.success(n.title, opts);
      else if (n.type === 'error') toast.error(n.title, opts);
      else if (n.type === 'warning') toast.warning(n.title, opts);
      else toast.info(n.title, opts);
    }

    markSeenMutation({ ids }).catch(() => {
      // best-effort -- notifications will expire via cron anyway
    });
  }, [adminNotifications, toast, markSeenMutation]);

  // Platform counts for onboarding + stats
  const [connectedPlatforms, setConnectedPlatforms] = useState(0);
  const [totalPlatforms, setTotalPlatforms] = useState(0);

  const handleCountsChange = useCallback((connected: number, total: number) => {
    setConnectedPlatforms(connected);
    setTotalPlatforms(total);
  }, []);

  // Onboarding dismiss — always start as false to match SSR, then read localStorage after mount
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(ONBOARDING_DISMISSED_KEY) === 'true') {
      setOnboardingDismissed(true);
    }
  }, []);

  const handleDismissOnboarding = useCallback(() => {
    setOnboardingDismissed(true);
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true');
  }, []);

  // Always start with default state (SSR-safe), then sync from localStorage after mount
  const [onboardingState, setOnboardingState] = useState<OnboardingState>({ docsRead: false });

  useEffect(() => {
    setOnboardingState(readOnboardingState());
  }, []);

  const markDocsRead = useCallback(() => {
    setOnboardingState((current) => {
      if (current.docsRead) {
        return current;
      }

      const next = { ...current, docsRead: true };
      localStorage.setItem(ONBOARDING_STATE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Onboarding steps
  const onboardingSteps: OnboardingStep[] = useMemo(() => {
    const hasServers = guilds.length > 0;
    const hasStore = connectedPlatforms > 1;
    return [
      {
        id: 'discord',
        label: 'Connect Discord',
        description: 'Link your Discord account to get started.',
        completed: true,
      },
      {
        id: 'store',
        label: 'Connect a Store',
        description: 'Link a storefront like Gumroad or Jinxxy.',
        completed: hasStore,
      },
      {
        id: 'server',
        label: 'Add a Server',
        description: 'Add a Discord server to manage.',
        completed: hasServers,
      },
      {
        id: 'docs',
        label: 'Read the Docs',
        description: 'Learn how to set up verifications and roles.',
        completed: onboardingState.docsRead,
        href: 'https://creators.yucp.club/docs.html',
        onClick: markDocsRead,
      },
    ];
  }, [guilds.length, connectedPlatforms, onboardingState.docsRead, markDocsRead]);

  // Auth error handling at page level
  if (status === 'signed_out' || status === 'expired') {
    return (
      <div className="pb-16">
        <DashboardAuthRequiredState
          title="Sign in to view your dashboard"
          description="Your session has expired. Please sign in again to access your dashboard."
        />
      </div>
    );
  }

  const allOnboardingComplete = onboardingSteps.every((s) => s.completed);

  if (isPersonalDashboard) {
    return (
      <div className="pb-16">
        <div className="grid grid-cols-12 gap-5">
          {/* Stats overview */}
          <div className="col-span-12">
            <StatsOverviewPanel />
          </div>

          {/* Connected platforms + recent activity */}
          <div className="col-span-12 lg:col-span-8">
            <ConnectedPlatformsPanel onCountsChange={handleCountsChange} />
          </div>
          <div className="col-span-12 lg:col-span-4">
            <RecentActivityPanel />
          </div>

          {/* Onboarding (conditional) */}
          {!onboardingDismissed && !allOnboardingComplete && (
            <div className="col-span-12">
              <OnboardingProgressPanel
                steps={onboardingSteps}
                onDismiss={handleDismissOnboarding}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Server dashboard
  const guildId = activeGuildId;
  const authUserId = activeTenantId;

  return (
    <div className="pb-16">
      <div className="grid grid-cols-12 gap-5">
        {/* Store integrations */}
        <div className="col-span-12">
          <StoreIntegrationsPanel
            authUserId={authUserId}
            guildId={guildId}
            canRunPanelQueries={canRunPanelQueries}
            onAuthError={() => {}}
          />
        </div>

        {/* Server settings + recent activity */}
        <div className="col-span-12 lg:col-span-8">
          {authUserId && guildId ? (
            <ServerSettingsPanel
              authUserId={authUserId}
              guildId={guildId}
              canRunPanelQueries={canRunPanelQueries}
            />
          ) : null}
        </div>
        <div className="col-span-12 lg:col-span-4">
          <RecentActivityPanel />
        </div>

        {/* Danger zone */}
        {guildId && (
          <div className="col-span-12">
            <DangerZonePanel guildId={guildId} />
          </div>
        )}
      </div>
    </div>
  );
}
