import {
  Component,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

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

function useDeferredFade() {
  const ready = useDeferredReady();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!ready) {
      setVisible(false);
      return;
    }

    const frameId = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frameId);
  }, [ready]);

  return { ready, visible };
}

function CloudBackgroundSurface() {
  return <div aria-hidden="true" className="cloud-background-surface" />;
}

function useOneShotCallback(callback?: () => void) {
  const calledRef = useRef(false);

  return useCallback(() => {
    if (!callback || calledRef.current) return;
    calledRef.current = true;
    callback();
  }, [callback]);
}

/**
 * Background sky canvas (z-index: 0, opaque).
 * Renders into the bg-canvas-root div that pages provide.
 */
export function CloudBackgroundLayer({ onReady }: { onReady?: () => void }) {
  const { ready, visible } = useDeferredFade();
  const [sceneReady, setSceneReady] = useState(false);
  const reportReady = useOneShotCallback(onReady);

  useEffect(() => {
    if (ready) return;
    setSceneReady(false);
  }, [ready]);

  useEffect(() => {
    if (!sceneReady || !visible) return;
    reportReady();
  }, [reportReady, sceneReady, visible]);

  return (
    <div className="cloud-layer-shell">
      <CloudBackgroundSurface />
      {ready ? (
        <div className={`cloud-layer-fade${visible ? ' is-visible' : ''}`}>
          <ErrorBoundary>
            <Suspense fallback={null}>
              <BackgroundApp onReady={() => setSceneReady(true)} />
            </Suspense>
          </ErrorBoundary>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Foreground clouds canvas (z-index: 1, transparent, pointer-events: none).
 */
export function CloudForegroundLayer() {
  const { ready, visible } = useDeferredFade();
  if (!ready) return null;
  return (
    <div className={`cloud-layer-fade${visible ? ' is-visible' : ''}`}>
      <ErrorBoundary>
        <Suspense fallback={null}>
          <ForegroundApp />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

/**
 * 404 3D text canvas (z-index: 2, transparent).
 */
export function Cloud404Layer() {
  const { ready, visible } = useDeferredFade();
  if (!ready) return null;
  return (
    <div className={`cloud-layer-fade${visible ? ' is-visible' : ''}`}>
      <ErrorBoundary>
        <Suspense fallback={null}>
          <Cloud404App />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

/**
 * Convenience: renders all cloud layers matching the original HTML structure.
 * For pages that need bg + fg: <CloudBackground variant="default" />
 * For 404 page: <CloudBackground variant="404" />
 */
export function CloudBackground({
  onReady,
  variant = 'default',
}: {
  onReady?: () => void;
  variant?: 'default' | '404';
}) {
  return (
    <>
      <div
        id="bg-canvas-root"
        style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}
      >
        <CloudBackgroundLayer onReady={onReady} />
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
