import './site.css';
import { Center, Cloud, Clouds, Sky as SkyImpl, Text3D, useTexture } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import confetti from 'canvas-confetti';
import HolographicSticker from 'holographic-sticker';
import { createIcons, icons } from 'lucide';
import { Suspense } from 'react';
import React, { Component, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import cloudTextureUrl from './assets/cloud.png';
import fontUrl from './assets/fonts/helvetiker_bold.typeface.json?url';

const HOLO_ASSET_MAP: Record<string, string> = {
  assistant: './Icons/Assistant.png',
  checkmark: './Icons/Checkmark.png',
  clapstars: './Icons/ClapStars.png',
  discord: './Icons/Discord.png',
  gumorad: './Icons/Gumorad.png',
  link: './Icons/Link.png',
  world: './Icons/World.png',
};

function createStickerTextureDataUrl(): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">
      <defs>
        <linearGradient id="base" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#8af5ff" stop-opacity="0.92" />
          <stop offset="20%" stop-color="#ff77c8" stop-opacity="0.9" />
          <stop offset="40%" stop-color="#fff07a" stop-opacity="0.85" />
          <stop offset="60%" stop-color="#7affb2" stop-opacity="0.9" />
          <stop offset="80%" stop-color="#87a8ff" stop-opacity="0.88" />
          <stop offset="100%" stop-color="#f8a7ff" stop-opacity="0.92" />
        </linearGradient>
        <pattern id="grain" width="32" height="32" patternUnits="userSpaceOnUse">
          <circle cx="6" cy="6" r="1.5" fill="white" fill-opacity="0.16" />
          <circle cx="18" cy="10" r="1" fill="white" fill-opacity="0.12" />
          <circle cx="26" cy="20" r="1.25" fill="white" fill-opacity="0.14" />
          <circle cx="10" cy="25" r="1.1" fill="white" fill-opacity="0.1" />
        </pattern>
      </defs>
      <rect width="320" height="320" fill="url(#base)" />
      <rect width="320" height="320" fill="url(#grain)" />
      <g opacity="0.3">
        <path d="M-40 90 C 40 10, 140 10, 240 90 S 420 170, 520 90" stroke="white" stroke-width="18" fill="none" />
        <path d="M-60 220 C 40 150, 140 160, 260 230 S 420 300, 520 220" stroke="white" stroke-width="14" fill="none" />
      </g>
    </svg>
  `.trim();
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

class ErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode }) {
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

function BackgroundSky() {
  return (
    <>
      <SkyImpl sunPosition={[100, 20, 100]} turbidity={0.8} rayleigh={0.5} />
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
          color="#ffffff"
          volume={15}
          opacity={0.6}
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
          color="#eaebff"
          volume={6}
          opacity={0.4}
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
          color="#d3e2ff"
          volume={40}
          opacity={0.9}
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
          color="#fdfdfd"
          volume={35}
          opacity={0.7}
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

function ForegroundSky() {
  return (
    <Clouds material={THREE.MeshLambertMaterial} texture={cloudTextureUrl} limit={4000} range={20}>
      <MovingCloud
        startX={45}
        speed={2.8}
        bounds={[10, 10, 5]}
        color="#f0f0f0"
        volume={12}
        opacity={0.8}
        seed={4}
        y={2}
        z={10}
        growth={15}
        fade={5}
        segments={15}
        concentrate="inside"
      />
      <MovingCloud
        startX={15}
        speed={3.5}
        bounds={[20, 5, 8]}
        color="#ffffff"
        volume={8}
        opacity={0.6}
        seed={6}
        y={-2}
        z={5}
        growth={5}
        fade={25}
        segments={12}
      />
    </Clouds>
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

function ForegroundApp() {
  return (
    <ErrorBoundary>
      <Canvas
        camera={{ position: [0, -5, 15], fov: 60 }}
        gl={{ alpha: true }}
        style={{ pointerEvents: 'none' }}
      >
        <ForegroundSky />
        <ambientLight intensity={Math.PI / 1.5} />
        <directionalLight position={[10, 20, 10]} intensity={1.5} color="#ffffff" />
      </Canvas>
    </ErrorBoundary>
  );
}

function Cloud404Text() {
  const cloudTexture = useTexture(cloudTextureUrl);
  return (
    <Center position={[0, 0, 5]}>
      <Text3D
        font={fontUrl}
        size={13}
        height={0.7}
        bevelEnabled
        bevelSize={0.04}
        bevelThickness={0.04}
      >
        404
        <meshBasicMaterial map={cloudTexture} color="#ffffff" transparent opacity={0.98} />
      </Text3D>
    </Center>
  );
}

function Cloud404App() {
  return (
    <ErrorBoundary>
      <Canvas
        camera={{ position: [0, -5, 26], fov: 60 }}
        gl={{ alpha: true }}
        style={{ pointerEvents: 'none' }}
      >
        <Suspense fallback={null}>
          <Cloud404Text />
        </Suspense>
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

function is404Page(): boolean {
  return document.body.dataset.page === '404';
}

function bootClouds() {
  const backgroundMount = document.getElementById('bg-canvas-root');
  if (backgroundMount) {
    createRoot(backgroundMount).render(<BackgroundApp />);
  }

  const canvas404Mount = document.getElementById('canvas-404-root');
  if (canvas404Mount && is404Page()) {
    createRoot(canvas404Mount).render(<Cloud404App />);
  } else {
    const foregroundMount = document.getElementById('fg-canvas-root');
    if (foregroundMount) {
      createRoot(foregroundMount).render(<ForegroundApp />);
    }
  }
}

// Expose window.lucide at module-evaluation time so any DOMContentLoaded handler
// (including those in setup pages loaded as plain <script> blocks) can call
// lucide.createIcons() safely.  The actual DOM scan is deferred to window.load
// so all markup is present.
const _lucideApply: (options?: Parameters<typeof createIcons>[0]) => void = (options = {}) =>
  createIcons({ icons, ...options });
(
  window as Window & {
    lucide?: { createIcons: typeof _lucideApply };
  }
).lucide = { createIcons: _lucideApply };

function bootLucide() {
  // Re-scan after full page load in case markup was inserted late.
  _lucideApply();
}

function bootConfetti() {
  (window as Window & { confetti?: typeof confetti }).confetti = confetti;
}

function extractHoloAssetKey(id: string): string | null {
  const match = id.match(/^holo-([a-z0-9]+)(?:-\d+)?$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function HoloWrapper({ src, alt }: { src: string; alt: string }) {
  const textureUrl = createStickerTextureDataUrl();
  return (
    <HolographicSticker.Root>
      <HolographicSticker.Scene>
        <HolographicSticker.Card className="w-full h-full rounded-2xl bg-transparent border-none overflow-visible">
          <HolographicSticker.ImageLayer src={src} alt={alt} objectFit="contain" />
          <HolographicSticker.Pattern
            maskUrl={src}
            maskSize="contain"
            textureUrl={textureUrl}
            textureSize="300px"
            mixBlendMode="hard-light"
            opacity={0.6}
          >
            <HolographicSticker.Refraction intensity={2.5} />
          </HolographicSticker.Pattern>
        </HolographicSticker.Card>
      </HolographicSticker.Scene>
    </HolographicSticker.Root>
  );
}

function bootHolographicStickers() {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('[id^="holo-"]'));
  for (const node of nodes) {
    const key = extractHoloAssetKey(node.id);
    if (!key) continue;
    const src = node.dataset.holoSrc ?? HOLO_ASSET_MAP[key];
    if (!src) continue;
    const alt = node.dataset.holoAlt ?? key.charAt(0).toUpperCase() + key.slice(1);
    createRoot(node).render(<HoloWrapper src={src} alt={alt} />);
  }
}

function hideLoading() {
  const overlay = document.getElementById('page-loading-overlay');
  const content = document.getElementById('page-content');
  if (overlay) overlay.style.display = 'none';
  if (content) content.style.display = '';
}

window.addEventListener('load', () => {
  bootConfetti();
  bootLucide();
  bootClouds();
  bootHolographicStickers();
  hideLoading();
});
