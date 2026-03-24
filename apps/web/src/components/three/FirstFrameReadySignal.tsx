import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';

export function FirstFrameReadySignal({ onReady }: { onReady?: () => void }) {
  const reportedRef = useRef(false);

  useFrame(() => {
    if (!onReady || reportedRef.current) return;
    reportedRef.current = true;
    onReady();
  });

  return null;
}
