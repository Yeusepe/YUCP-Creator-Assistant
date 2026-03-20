import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ApiError } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { useHasHydrated } from '@/hooks/useHasHydrated';

export type DashboardSessionStatus = 'resolving' | 'signed_out' | 'expired' | 'active';

interface DashboardSessionContextValue {
  canRunPanelQueries: boolean;
  clearSessionExpired: () => void;
  hasHydrated: boolean;
  isAuthenticated: boolean;
  isAuthResolved: boolean;
  isSessionExpired: boolean;
  markSessionExpired: () => void;
  status: DashboardSessionStatus;
}

const DashboardSessionContext = createContext<DashboardSessionContextValue | null>(null);

export function DashboardSessionProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isPending } = useAuth();
  const hasHydrated = useHasHydrated();
  const [isSessionExpired, setSessionExpired] = useState(false);

  const markSessionExpired = useCallback(() => {
    setSessionExpired(true);
  }, []);

  const clearSessionExpired = useCallback(() => {
    setSessionExpired(false);
  }, []);

  useEffect(() => {
    if (!isPending && !isAuthenticated) {
      setSessionExpired(false);
    }
  }, [isAuthenticated, isPending]);

  const isAuthResolved = hasHydrated && !isPending;
  const status: DashboardSessionStatus = !isAuthResolved
    ? 'resolving'
    : !isAuthenticated
      ? 'signed_out'
      : isSessionExpired
        ? 'expired'
        : 'active';

  const value = useMemo(
    () => ({
      canRunPanelQueries: status === 'active',
      clearSessionExpired,
      hasHydrated,
      isAuthenticated,
      isAuthResolved,
      isSessionExpired,
      markSessionExpired,
      status,
    }),
    [
      clearSessionExpired,
      hasHydrated,
      isAuthenticated,
      isAuthResolved,
      isSessionExpired,
      markSessionExpired,
      status,
    ]
  );

  return (
    <DashboardSessionContext.Provider value={value}>{children}</DashboardSessionContext.Provider>
  );
}

export function useDashboardSession() {
  const context = useContext(DashboardSessionContext);
  if (!context) {
    throw new Error('useDashboardSession must be used within DashboardSessionProvider');
  }

  return context;
}

export function isDashboardAuthError(error: unknown) {
  if (error instanceof ApiError) {
    return error.status === 401;
  }

  if (error instanceof Error) {
    return /authentication required|not authenticated/i.test(error.message);
  }

  return false;
}
