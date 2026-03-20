import { useCallback, useEffect, useRef } from 'react';

type PageRevealGateOptions = {
  fallbackDelayMs?: number;
  reveal: () => void;
};

export function usePageRevealGate({ fallbackDelayMs = 2000, reveal }: PageRevealGateOptions) {
  const hasRevealedRef = useRef(false);

  const revealOnce = useCallback(() => {
    if (hasRevealedRef.current) return;
    hasRevealedRef.current = true;
    reveal();
  }, [reveal]);

  useEffect(() => {
    const fallbackTimer = window.setTimeout(() => {
      revealOnce();
    }, fallbackDelayMs);

    return () => {
      window.clearTimeout(fallbackTimer);
    };
  }, [fallbackDelayMs, revealOnce]);

  return revealOnce;
}
