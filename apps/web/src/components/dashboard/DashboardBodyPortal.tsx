import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export function DashboardBodyPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  if (!mounted || typeof document === 'undefined') {
    return null;
  }

  const portalRoot = document.getElementById('portal-root');
  if (!portalRoot) {
    return null;
  }

  return createPortal(children, portalRoot);
}
