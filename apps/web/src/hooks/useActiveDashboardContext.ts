import { useDashboardShell } from '@/hooks/useDashboardShell';
import { useServerContext } from '@/hooks/useServerContext';

export function useActiveDashboardContext() {
  const { guildId, isPersonalDashboard, tenantId } = useServerContext();
  const { selectedGuild, viewer } = useDashboardShell();

  const activeGuildId = selectedGuild?.id ?? guildId;
  const activeTenantId = selectedGuild?.tenantId ?? tenantId ?? viewer?.authUserId;

  return {
    activeGuildId,
    activeTenantId,
    isPersonalDashboard: isPersonalDashboard && !selectedGuild,
    selectedGuild,
    viewer,
  };
}
