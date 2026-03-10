import './collab-invite.css';
import { Cloud, Clouds, Sky as SkyImpl } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import confetti from 'canvas-confetti';
import React, { Component, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import cloudTextureUrl from './assets/cloud.png';

class ErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  // Use the standard React instance lifecycle to avoid conflicts with differing
  // React type definitions across environments.
  override componentDidCatch(_error: unknown) {
    this.setState({ hasError: true });
  }
  override render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

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
  concentrate?: 'inside' | 'outside' | 'random';
};

function MovingCloud({
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
  const ref = useRef<any>(null);

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

function BackgroundSky() {
  return (
    <>
      <SkyImpl sunPosition={[100, 20, 100]} turbidity={1.2} rayleigh={0.6} />
      <Clouds
        material={THREE.MeshLambertMaterial}
        texture={cloudTextureUrl}
        limit={4000}
        range={20}
      >
        <MovingCloud
          startX={0}
          speed={1.5}
          bounds={[25, 6, 15]}
          color="#8fa3c9"
          volume={15}
          opacity={0.45}
          seed={1}
          y={0}
          z={-10}
          growth={4}
          fade={10}
          segments={20}
        />
        <MovingCloud
          startX={30}
          speed={2.2}
          bounds={[10, 4, 10]}
          color="#7a8fb8"
          volume={6}
          opacity={0.35}
          seed={2}
          y={8}
          z={-20}
          growth={8}
          fade={20}
          segments={10}
        />
        <MovingCloud
          startX={-20}
          speed={0.5}
          bounds={[60, 5, 40]}
          color="#6b82a8"
          volume={40}
          opacity={0.55}
          seed={3}
          y={-5}
          z={-35}
          growth={2}
          fade={30}
          segments={40}
          concentrate="outside"
        />
        <MovingCloud
          startX={-45}
          speed={1.0}
          bounds={[30, 20, 30]}
          color="#9aa8c4"
          volume={35}
          opacity={0.5}
          seed={5}
          y={5}
          z={-25}
          growth={6}
          fade={15}
          segments={35}
          concentrate="random"
        />
      </Clouds>
    </>
  );
}

function BackgroundApp() {
  return (
    <ErrorBoundary>
      <Canvas camera={{ position: [0, -5, 15], fov: 60 }} gl={{ alpha: false }}>
        <BackgroundSky />
        <ambientLight intensity={Math.PI / 1.5} />
        <directionalLight position={[10, 20, 10]} intensity={1.5} color="#ffffff" />
        <spotLight
          position={[-20, 0, 10]}
          color="#ffdddd"
          angle={0.8}
          decay={0}
          penumbra={1}
          intensity={10}
        />
      </Canvas>
    </ErrorBoundary>
  );
}

function bootBackground() {
  const mount = document.getElementById('bg-canvas-root');
  if (!mount) return;
  createRoot(mount).render(<BackgroundApp />);
}

function bootIcons() {
  for (const node of Array.from(document.querySelectorAll('[data-lucide]'))) {
    (node as Element).classList.add('lucide-icon');
  }
}

function exposeConfetti() {
  (window as Window & { confetti?: typeof confetti }).confetti = confetti;
}

function hideLoading() {
  const overlay = document.getElementById('page-loading-overlay');
  const content = document.getElementById('page-content');
  if (overlay) overlay.style.display = 'none';
  if (content) content.style.display = '';
}

window.addEventListener('load', () => {
  exposeConfetti();
  bootIcons();
  bootBackground();
  hideLoading();
});
