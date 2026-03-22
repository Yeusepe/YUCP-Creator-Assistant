import './site.css';
import { Center, Cloud, Clouds, Sky as SkyImpl, Text3D, useTexture } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import confetti from 'canvas-confetti';
import HolographicSticker from 'holographic-sticker';
import { createIcons, icons } from 'lucide';
import React, { Component, Suspense, useRef } from 'react';
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

const _BAG_PATH =
  'M10.4532 65.9999C3.56938 65.9999 0 62.4297 0 55.5789V22.2894C0 15.4064 3.56938 11.8684' +
  ' 10.4532 11.8684H15.6479C16.3172 5.08187 21.7031 0 28.7781 0C35.885 0 41.271 5.0497' +
  ' 41.9084 11.8684H47.135C53.9869 11.8684 57.5882 15.4386 57.5882 22.2894V55.5789C57.5882' +
  ' 62.4297 54.0188 65.9999 47.9317 65.9999H10.4532ZM28.7781 5.62865C25.0176 5.62865 22.2768' +
  ' 8.13742 21.735 11.8684H35.8532C35.3114 8.13742 32.5706 5.62865 28.7781 5.62865Z';

function bootLoadingOverlay() {
  const overlay = document.getElementById('page-loading-overlay');
  if (!overlay || overlay.children.length > 0) return;
  overlay.innerHTML =
    '<div class="plo-bag-scene">' +
    '<svg class="plo-bag-outline" viewBox="0 0 58 66" fill="none"' +
    ' xmlns="http://www.w3.org/2000/svg" aria-hidden="true" overflow="visible">' +
    `<path d="${_BAG_PATH}" fill="none" stroke="white" stroke-width="10"/>` +
    '</svg>' +
    '<div class="plo-bag-color">' +
    '<div class="plo-blob plo-blob-1"></div>' +
    '<div class="plo-blob plo-blob-2"></div>' +
    '<div class="plo-blob plo-blob-3"></div>' +
    '<div class="plo-blob plo-blob-4"></div>' +
    '<div class="plo-blob plo-blob-5"></div>' +
    '</div>' +
    '</div>' +
    '<div class="plo-bar-wrap"><div class="plo-bar"></div></div>';
}

function dismissOverlay() {
  const overlay = document.getElementById('page-loading-overlay');
  if (!overlay || overlay.classList.contains('is-hiding')) return;
  overlay.classList.add('is-hiding');
  setTimeout(() => {
    overlay.style.display = 'none';
  }, 600);
}

function hideLoading() {
  const _overlay = document.getElementById('page-loading-overlay');
  const content = document.getElementById('page-content');

  // Step 1: reveal content underneath the still-opaque overlay so it can
  // layout and paint without the user seeing anything.
  if (content) {
    content.style.display = '';
    requestAnimationFrame(() => requestAnimationFrame(() => content.classList.add('is-visible')));
  }

  // If the page defers overlay dismiss (e.g. dashboard waits for data),
  // expose a global callback and skip the automatic hide.
  if ((window as any).__deferLoadingDismiss) {
    (window as any).__dismissLoading = () => {
      setTimeout(dismissOverlay, 400);
    };
    return;
  }

  // Step 2: after content finishes its own 0.3s opacity transition + paint
  // buffer, fade the overlay out over the already-visible page.
  setTimeout(dismissOverlay, 400);
}

// Populate the loading overlay as early as possible (module scripts run after DOM parse).
bootLoadingOverlay();

window.addEventListener('load', () => {
  bootConfetti();
  bootLucide();
  bootClouds();
  bootHolographicStickers();
  hideLoading();
});
