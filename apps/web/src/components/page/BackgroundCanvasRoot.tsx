import { CloudBackgroundLayer } from '@/components/three/CloudBackground';

type BackgroundCanvasRootProps = {
  onReady?: () => void;
  zIndex?: number;
  position?: 'fixed' | 'absolute';
};

export function BackgroundCanvasRoot({
  onReady,
  zIndex = -20,
  position = 'fixed',
}: BackgroundCanvasRootProps) {
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
      <CloudBackgroundLayer onReady={onReady} />
    </div>
  );
}
