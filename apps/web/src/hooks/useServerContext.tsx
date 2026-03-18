import { createContext, type ReactNode, useContext } from 'react';

interface ServerContextValue {
  guildId: string | undefined;
  tenantId: string | undefined;
  isPersonalDashboard: boolean;
}

const ServerContext = createContext<ServerContextValue>({
  guildId: undefined,
  tenantId: undefined,
  isPersonalDashboard: true,
});

export function useServerContext() {
  return useContext(ServerContext);
}

export function ServerContextProvider({
  guildId,
  tenantId,
  children,
}: {
  guildId: string | undefined;
  tenantId: string | undefined;
  children: ReactNode;
}) {
  const isPersonalDashboard = !guildId;

  return (
    <ServerContext value={{ guildId, tenantId, isPersonalDashboard }}>{children}</ServerContext>
  );
}
