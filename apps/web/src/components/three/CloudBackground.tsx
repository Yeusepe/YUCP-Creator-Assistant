import { Component, lazy, type ReactNode, Suspense, useEffect, useState } from 'react';

const BackgroundApp = lazy(() => import('./BackgroundApp'));
const ForegroundApp = lazy(() => import('./ForegroundApp'));
const Cloud404App = lazy(() => import('./Cloud404App'));

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  override componentDidCatch(_error: unknown) {
    this.setState({ hasError: true });
  }
  override render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function useDeferredReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if ('requestIdleCallback' in window) {
      const id = requestIdleCallback(() => setReady(true), { timeout: 2000 });
      return () => cancelIdleCallback(id);
    }
    const timer = setTimeout(() => setReady(true), 100);
    return () => clearTimeout(timer);
  }, []);
  return ready;
}

/**
 * Background sky canvas (z-index: 0, opaque).
 * Renders into the bg-canvas-root div that pages provide.
 */
export function CloudBackgroundLayer() {
  const ready = useDeferredReady();
  if (!ready) return null;
  return (
    <ErrorBoundary>
      <Suspense fallback={null}>
        <BackgroundApp />
      </Suspense>
    </ErrorBoundary>
  );
}

/**
 * Foreground clouds canvas (z-index: 1, transparent, pointer-events: none).
 */
export function CloudForegroundLayer() {
  const ready = useDeferredReady();
  if (!ready) return null;
  return (
    <ErrorBoundary>
      <Suspense fallback={null}>
        <ForegroundApp />
      </Suspense>
    </ErrorBoundary>
  );
}

/**
 * 404 3D text canvas (z-index: 2, transparent).
 */
export function Cloud404Layer() {
  const ready = useDeferredReady();
  if (!ready) return null;
  return (
    <ErrorBoundary>
      <Suspense fallback={null}>
        <Cloud404App />
      </Suspense>
    </ErrorBoundary>
  );
}

/**
 * Convenience: renders all cloud layers matching the original HTML structure.
 * For pages that need bg + fg: <CloudBackground variant="default" />
 * For 404 page: <CloudBackground variant="404" />
 */
export function CloudBackground({ variant = 'default' }: { variant?: 'default' | '404' }) {
  return (
    <>
      <div
        id="bg-canvas-root"
        style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}
      >
        <CloudBackgroundLayer />
      </div>
      {variant === '404' ? (
        <div id="canvas-404-root" style={{ position: 'relative', zIndex: 2 }}>
          <Cloud404Layer />
        </div>
      ) : (
        <div
          id="fg-canvas-root"
          style={{ position: 'fixed', inset: 0, zIndex: 1, pointerEvents: 'none' }}
        >
          <CloudForegroundLayer />
        </div>
      )}
    </>
  );
}
