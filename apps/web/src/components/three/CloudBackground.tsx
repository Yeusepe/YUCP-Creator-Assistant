import { Component, lazy, type ReactNode, Suspense, useEffect, useState } from 'react';

const BackgroundApp = lazy(() => import('./BackgroundApp'));
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

function useClientReady() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  return ready;
}

function CloudBackgroundSurface({ hidden = false }: { hidden?: boolean }) {
  return (
    <div aria-hidden="true" className={`cloud-background-surface${hidden ? ' is-hidden' : ''}`} />
  );
}

/** Background sky layer with a static fallback until the first rendered frame. */
export function CloudBackgroundLayer() {
  const ready = useClientReady();
  const [sceneReady, setSceneReady] = useState(false);

  return (
    <div className="cloud-layer-shell">
      <CloudBackgroundSurface hidden={sceneReady} />
      {ready ? (
        <div className={`cloud-scene-layer${sceneReady ? ' is-ready' : ''}`}>
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
 * 404 3D text canvas (z-index: 2, transparent).
 */
export function Cloud404Layer() {
  const ready = useClientReady();
  if (!ready) return null;
  return (
    <div className="cloud-scene-layer is-ready">
      <ErrorBoundary>
        <Suspense fallback={null}>
          <Cloud404App />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

type CloudBackgroundProps = {
  position: 'fixed' | 'absolute';
  zIndex: number;
};

export function CloudBackground({ position, zIndex }: CloudBackgroundProps) {
  const sizeStyle =
    position === 'absolute'
      ? {
          position: 'absolute' as const,
          inset: 0,
          width: '100%',
          height: '100%',
        }
      : {
          position: 'fixed' as const,
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
        };

  return (
    <div
      id="bg-canvas-root"
      style={{
        ...sizeStyle,
        zIndex,
        pointerEvents: 'none',
      }}
    >
      <CloudBackgroundLayer />
    </div>
  );
}
