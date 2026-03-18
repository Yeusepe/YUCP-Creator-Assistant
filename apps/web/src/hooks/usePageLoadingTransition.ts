import { useCallback, useEffect, useRef } from 'react';

type PageLoadingTransitionOptions = {
  contentId?: string;
  overlayId?: string;
  visibleClass?: string;
  overlayFadeClass?: 'fade-out' | 'is-hiding';
  overlayFadeDelayMs?: number;
  overlayRemoveDelayMs?: number;
  unhideDisplay?: boolean;
  onReveal?: () => void;
};

export function usePageLoadingTransition({
  contentId = 'page-content',
  overlayId = 'page-loading-overlay',
  visibleClass = 'is-visible',
  overlayFadeClass = 'is-hiding',
  overlayFadeDelayMs = 400,
  overlayRemoveDelayMs = 650,
  unhideDisplay = false,
  onReveal,
}: PageLoadingTransitionOptions = {}) {
  const timersRef = useRef<number[]>([]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) {
        window.clearTimeout(timer);
      }
      timersRef.current = [];
    },
    []
  );

  return useCallback(() => {
    if (typeof document === 'undefined') return;

    const overlay = document.getElementById(overlayId);
    const content = document.getElementById(contentId);

    if (onReveal) {
      onReveal();
    } else if (content) {
      if (unhideDisplay && content.style.display === 'none') {
        content.style.display = '';
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          content.classList.add(visibleClass);
        });
      });
    }

    if (!overlay || overlay.classList.contains(overlayFadeClass)) return;

    const fadeTimer = window.setTimeout(() => {
      overlay.classList.add(overlayFadeClass);
      const removeTimer = window.setTimeout(() => {
        overlay.style.display = 'none';
      }, overlayRemoveDelayMs);
      timersRef.current.push(removeTimer);
    }, overlayFadeDelayMs);

    timersRef.current.push(fadeTimer);
  }, [
    contentId,
    overlayFadeClass,
    overlayFadeDelayMs,
    overlayId,
    overlayRemoveDelayMs,
    onReveal,
    unhideDisplay,
    visibleClass,
  ]);
}
