import { CloudBackgroundLayer } from '@/components/three/CloudBackground';

type BackgroundCanvasRootProps = {
  zIndex?: number;
};

export function BackgroundCanvasRoot({ zIndex = -20 }: BackgroundCanvasRootProps) {
  return (
    <div
      id="bg-canvas-root"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        zIndex,
        pointerEvents: 'none',
      }}
    >
      <CloudBackgroundLayer />
    </div>
  );
}
