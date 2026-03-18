import { Cloud, type CloudProps } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type * as THREE from 'three';

type MovingCloudProps = {
  startX: number;
  speed: number;
  bounds: [number, number, number];
  color: string;
  volume: number;
  opacity: number;
  seed: number;
  y: number;
  z: number;
  growth: number;
  fade: number;
  segments: number;
  concentrate?: CloudProps['concentrate'];
};

export function MovingCloud({
  startX,
  speed,
  bounds,
  color,
  volume,
  opacity,
  seed,
  y,
  z,
  growth,
  fade,
  segments,
  concentrate,
}: MovingCloudProps) {
  const ref = useRef<THREE.Group | null>(null);

  useFrame((state) => {
    if (!ref.current) return;
    const elapsed = state.clock.getElapsedTime();
    const range = 240;
    let currentX = startX - elapsed * speed;
    currentX = ((((currentX + 120) % range) + range) % range) - 120;
    ref.current.position.x = currentX;
  });

  return (
    <group ref={ref} position={[startX, y, z]}>
      <Cloud
        bounds={bounds}
        color={color}
        volume={volume}
        opacity={opacity}
        seed={seed}
        growth={growth}
        fade={fade}
        segments={segments}
        concentrate={concentrate}
        position={[0, 0, 0]}
      />
    </group>
  );
}
