import './index.css';
import { Cloud, Clouds } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import React, { Component, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';

class ErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown) {
    console.error('Three.js Canvas Error', error);
  }

  override render() {
    return this.state.hasError ? null : this.props.children;
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
    const halfRange = 30;
    const range = halfRange * 2;
    let currentX = startX - elapsed * speed;

    currentX = ((((currentX + halfRange) % range) + range) % range) - halfRange;
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

function ForegroundSky() {
  return (
    <Clouds material={THREE.MeshLambertMaterial} limit={4000} range={20}>
      <MovingCloud
        startX={0}
        speed={0.9}
        bounds={[10, 10, 5]}
        color="#f0f0f0"
        volume={12}
        opacity={0.95}
        seed={4}
        y={2}
        z={10}
        growth={15}
        fade={5}
        segments={15}
        concentrate="inside"
      />
      <MovingCloud
        startX={0}
        speed={1.1}
        bounds={[20, 5, 8]}
        color="#ffffff"
        volume={8}
        opacity={0.9}
        seed={6}
        y={-2}
        z={5}
        growth={5}
        fade={25}
        segments={12}
      />
      <MovingCloud
        startX={0}
        speed={0.8}
        bounds={[30, 15, 25]}
        color="#fff"
        volume={30}
        opacity={0.85}
        seed={9}
        y={0}
        z={8}
        growth={20}
        fade={15}
        segments={40}
      />
    </Clouds>
  );
}

function ForegroundApp() {
  return (
    <ErrorBoundary>
      <Canvas
        camera={{ position: [0, -5, 15], fov: 60 }}
        gl={{ alpha: true }}
        onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
        style={{ pointerEvents: 'none' }}
      >
        <ForegroundSky />
        <ambientLight intensity={Math.PI / 1.5} />
        <directionalLight position={[10, 20, 10]} intensity={1.5} color="#ffffff" />
      </Canvas>
    </ErrorBoundary>
  );
}

const backgroundRoot = document.getElementById('bg-canvas-root');
const foregroundRoot = document.getElementById('fg-canvas-root');

if (backgroundRoot) {
  createRoot(backgroundRoot).render(null);
}

if (foregroundRoot) {
  createRoot(foregroundRoot).render(<ForegroundApp />);
}

(() => {
  const container = document.getElementById('blobs-container');

  if (!container) return;

  const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);

  function updateBlobIntensity() {
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    const t = Math.min(1, scrollY / (maxScroll * 0.6));
    const intensity = 1 - t * 0.18;

    container.style.setProperty('--blob-intensity', String(intensity));
  }

  updateBlobIntensity();
  window.addEventListener('scroll', updateBlobIntensity, { passive: true });
})();

(() => {
  const overlay = document.getElementById('scroll-blur-overlay');
  const hero = document.getElementById('hero');
  const features = document.getElementById('features');
  const pageContent = document.getElementById('page-content');

  if (!overlay || !hero || !features) return;

  const maxBlur = 10;
  const maxDarken = 0.22;

  function updateScrollBlur() {
    if (pageContent && (pageContent.style.display === 'none' || hero.offsetHeight === 0)) {
      overlay.style.setProperty('--scroll-blur', '0');
      overlay.style.setProperty('--scroll-darken', String(maxDarken));
      return;
    }

    const scrollY = window.scrollY || document.documentElement.scrollTop;
    const start = Math.max(0, 80);
    const end = features.offsetTop - window.innerHeight * 0.15;
    const t = Math.max(0, Math.min(1, (scrollY - start) / Math.max(1, end - start)));

    overlay.style.setProperty('--scroll-blur', String(t * maxBlur));
    overlay.style.setProperty('--scroll-darken', String(maxDarken));
  }

  overlay.style.setProperty('--scroll-blur', '0');
  overlay.style.setProperty('--scroll-darken', String(maxDarken));

  window.addEventListener('scroll', updateScrollBlur, { passive: true });
  window.addEventListener('page-content-visible', updateScrollBlur);
})();

(() => {
  const heroInner = document.querySelector<HTMLElement>('#hero .hero-inner');
  const glass = document.getElementById('sections-glass');
  const pageContent = document.getElementById('page-content');

  if (!heroInner || !glass) return;

  heroInner.style.opacity = '1';

  function updateHeroFade() {
    if (pageContent && pageContent.style.display === 'none') return;

    const glassTop = glass.getBoundingClientRect().top;
    const vh = window.innerHeight;
    const fadeStart = vh * 0.8;
    const fadeEnd = vh * 0.2;
    const t = Math.max(0, Math.min(1, (fadeStart - glassTop) / (fadeStart - fadeEnd)));

    heroInner.style.opacity = String(1 - t);
  }

  window.addEventListener('scroll', updateHeroFade, { passive: true });
  window.addEventListener('page-content-visible', updateHeroFade);
})();

(() => {
  const blobs = Array.from(document.querySelectorAll<HTMLElement>('.blob'));

  if (!blobs.length) return;

  const width = () => window.innerWidth;
  const height = () => window.innerHeight;
  const half = 325;
  const lerp = 0.025;
  const mouseInfluence = 35;
  const mouseBlobMultipliers = [0.8, 1.2, 0.6, 1.0, 1.4];

  let mouseX = 0.5;
  let mouseY = 0.5;

  document.addEventListener('mousemove', (event) => {
    mouseX = event.clientX / window.innerWidth;
    mouseY = event.clientY / window.innerHeight;
  });

  const mouseOff = () => {
    const dx = (mouseX - 0.5) * 2 * mouseInfluence;
    const dy = (mouseY - 0.5) * 2 * mouseInfluence;

    return { dx, dy };
  };

  const currentPos = blobs.map((_, index) => {
    const point = [
      { cx: 0.1, cy: 0.1 },
      { cx: 0.7, cy: 0.05 },
      { cx: 0.45, cy: 0.5 },
      { cx: 0.1, cy: 0.7 },
      { cx: 0.75, cy: 0.65 },
    ][index];

    return { x: point.cx * width() - half, y: point.cy * height() - half };
  });

  function getGraphicCenter(section: Element) {
    const graphic = section.querySelector('.section-graphic');
    const rect =
      graphic && graphic.getBoundingClientRect().width > 0
        ? graphic.getBoundingClientRect()
        : section.getBoundingClientRect();

    return {
      x: rect.left + rect.width / 2 - half,
      y: rect.top + rect.height / 2 - half,
    };
  }

  const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-blob-index]'));
  let activeSection: HTMLElement | null = null;
  let activeAnchor = { x: 0, y: 0 };

  const heroEl = document.getElementById('hero');
  const glassEl = document.getElementById('sections-glass');

  function updateActiveSection() {
    const vh = window.innerHeight;
    const glassTop = glassEl ? glassEl.getBoundingClientRect().top : vh;
    const heroActive = glassTop > vh * 0.5;

    let best: HTMLElement | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    const viewCenter = window.scrollY + vh / 2;

    sections.forEach((section) => {
      if (section === heroEl) {
        if (heroActive) best = section;
        return;
      }

      const rect = section.getBoundingClientRect();
      const sectionTop = rect.top + window.scrollY;
      const sectionCenter = sectionTop + rect.height / 2;
      const dist = Math.abs(viewCenter - sectionCenter);
      const inView = rect.top < vh * 0.85 && rect.bottom > vh * 0.15;

      if (inView && dist < bestDist) {
        bestDist = dist;
        best = section;
      }
    });

    activeSection = best;
  }

  const observer = new IntersectionObserver(() => updateActiveSection(), {
    threshold: [0, 0.1, 0.2, 0.5],
    rootMargin: '-15% 0px -15% 0px',
  });

  sections.forEach((section) => {
    observer.observe(section);
  });
  window.addEventListener('scroll', updateActiveSection, { passive: true });

  const defaultParams = [
    { cx: 0.1, cy: 0.1, ax: 0.25, ay: 0.2, fx: 0.00028, fy: 0.00021, ph: 0 },
    { cx: 0.7, cy: 0.05, ax: 0.22, ay: 0.25, fx: 0.00019, fy: 0.00033, ph: 1.26 },
    { cx: 0.45, cy: 0.5, ax: 0.3, ay: 0.22, fx: 0.00035, fy: 0.00017, ph: 2.51 },
    { cx: 0.1, cy: 0.7, ax: 0.2, ay: 0.22, fx: 0.00023, fy: 0.00029, ph: 3.77 },
    { cx: 0.75, cy: 0.65, ax: 0.24, ay: 0.2, fx: 0.0003, fy: 0.00024, ph: 5.03 },
  ];

  const danceParams = [
    { ax: 180, ay: 120, fx: 0.0025, fy: 0.0018, ph: 0 },
    { ax: 150, ay: 100, fx: 0.0022, fy: 0.0025, ph: 1.5 },
    { ax: 200, ay: 130, fx: 0.0018, fy: 0.0022, ph: 3 },
    { ax: 160, ay: 140, fx: 0.0028, fy: 0.0015, ph: 4.5 },
  ];

  const heroRandomParams = [
    { cx: 0.2, cy: 0.3, ax: 0.35, ay: 0.28, fx: 0.00045, fy: 0.00038, ph: 0 },
    { cx: 0.6, cy: 0.15, ax: 0.28, ay: 0.32, fx: 0.00032, fy: 0.00052, ph: 2.1 },
    { cx: 0.5, cy: 0.55, ax: 0.38, ay: 0.25, fx: 0.00058, fy: 0.00028, ph: 4.2 },
    { cx: 0.15, cy: 0.72, ax: 0.22, ay: 0.3, fx: 0.00035, fy: 0.00048, ph: 1.1 },
    { cx: 0.78, cy: 0.62, ax: 0.3, ay: 0.22, fx: 0.00042, fy: 0.00035, ph: 5.7 },
  ];

  function tick(time: number) {
    const w = width();
    const h = height();
    const { dx: mdx, dy: mdy } = mouseOff();
    const isHero = activeSection?.id === 'hero';

    if (activeSection && !isHero) {
      activeAnchor = getGraphicCenter(activeSection);
      const anchorIdx = Number.parseInt(activeSection.dataset.blobIndex ?? '', 10);

      blobs.forEach((blob, index) => {
        blob.classList.add('dancing');

        const mult = mouseBlobMultipliers[index] || 1;
        let tx: number;
        let ty: number;

        if (index === anchorIdx) {
          blob.classList.add('latched');
          blob.classList.remove('dancing');
          tx = activeAnchor.x + mdx * mult * 0.5;
          ty = activeAnchor.y + mdy * mult * 0.5;
        } else {
          blob.classList.remove('latched');
          const params =
            danceParams[index > anchorIdx ? index - 1 : index] ||
            danceParams[index % danceParams.length];
          const dx = Math.sin(time * params.fx + params.ph) * params.ax;
          const dy = Math.cos(time * params.fy + params.ph * 1.3) * params.ay;

          tx = activeAnchor.x + dx + mdx * mult;
          ty = activeAnchor.y + dy + mdy * mult;
        }

        currentPos[index].x += (tx - currentPos[index].x) * lerp;
        currentPos[index].y += (ty - currentPos[index].y) * lerp;
        blob.style.transform = `translate(${currentPos[index].x}px, ${currentPos[index].y}px)`;
      });
    } else if (isHero) {
      blobs.forEach((blob, index) => {
        blob.classList.add('dancing');
        blob.classList.remove('latched');

        const params = heroRandomParams[index];
        const mult = mouseBlobMultipliers[index] || 1;
        const tx =
          (params.cx + Math.sin(time * params.fx + params.ph) * params.ax) * w - half + mdx * mult;
        const ty =
          (params.cy + Math.cos(time * params.fy + params.ph * 1.4) * params.ay) * h -
          half +
          mdy * mult;

        currentPos[index].x += (tx - currentPos[index].x) * lerp;
        currentPos[index].y += (ty - currentPos[index].y) * lerp;
        blob.style.transform = `translate(${currentPos[index].x}px, ${currentPos[index].y}px)`;
      });
    } else {
      blobs.forEach((blob, index) => {
        blob.classList.remove('latched', 'dancing');

        const params = defaultParams[index];
        const mult = mouseBlobMultipliers[index] || 1;
        const tx =
          (params.cx + Math.sin(time * params.fx + params.ph) * params.ax) * w - half + mdx * mult;
        const ty =
          (params.cy + Math.cos(time * params.fy + params.ph * 1.4) * params.ay) * h -
          half +
          mdy * mult;

        currentPos[index].x += (tx - currentPos[index].x) * lerp;
        currentPos[index].y += (ty - currentPos[index].y) * lerp;
        blob.style.transform = `translate(${currentPos[index].x}px, ${currentPos[index].y}px)`;
      });
    }

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();

(() => {
  const overlay = document.getElementById('page-loading-overlay');
  const content = document.getElementById('page-content');

  if (!overlay || !content) return;

  content.style.display = '';

  requestAnimationFrame(() => {
    overlay.classList.add('is-hiding');
    content.classList.add('is-visible');
    window.dispatchEvent(new CustomEvent('page-content-visible'));
  });
})();

(() => {
  const gsapApi = globalThis.gsap;
  const scrollTriggerApi = globalThis.ScrollTrigger;

  if (!gsapApi || !scrollTriggerApi) return;

  gsapApi.registerPlugin(scrollTriggerApi);

  document
    .querySelectorAll('#sections-glass section[data-blob-index]:not(#features):not(#security)')
    .forEach((section) => {
      const inner = section.querySelector('.max-w-7xl, .max-w-6xl');

      if (!inner) return;

      const columns = Array.from(inner.children);

      if (columns.length < 2) return;

      const isReverse = inner.classList.contains('lg:flex-row-reverse');
      const first = columns[0];
      const second = columns[1];

      if (first.classList.contains('reveal')) {
        first.classList.add(isReverse ? 'reveal-r' : 'reveal-l');
      }

      if (second.classList.contains('reveal')) {
        second.classList.add(isReverse ? 'reveal-l' : 'reveal-r');
      }
    });

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  document.querySelectorAll('#sections-glass .bento-card').forEach((card) => {
    gsapApi.fromTo(
      card,
      { rotateX: 20, y: 36, transformPerspective: 1100, transformOrigin: 'center 120%' },
      {
        rotateX: 0,
        y: 0,
        duration: 0.82,
        ease: 'power3.out',
        clearProps: 'all',
        scrollTrigger: { trigger: card, start: 'top 82%', once: true },
      }
    );
  });

  document
    .querySelectorAll('#sections-glass section[data-blob-index]:not(#features) h2')
    .forEach((heading) => {
      gsapApi.fromTo(
        heading,
        { clipPath: 'inset(0 0 108% 0)', y: 28 },
        {
          clipPath: 'inset(0 0 0% 0)',
          y: 0,
          duration: 0.88,
          ease: 'power3.out',
          clearProps: 'clipPath,y',
          scrollTrigger: { trigger: heading, start: 'top 87%', once: true },
        }
      );
    });

  document
    .querySelectorAll('#sections-glass section[data-blob-index] .tag-pill')
    .forEach((pill, index) => {
      gsapApi.fromTo(
        pill,
        { y: 14, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          duration: 0.5,
          ease: 'power2.out',
          scrollTrigger: { trigger: pill, start: 'top 90%', once: true },
          delay: (index % 4) * 0.08,
        }
      );
    });
})();

(() => {
  const element = document.querySelector('#features .text-reveal');

  if (!element) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('text-reveal-visible');
        }
      });
    },
    { threshold: 0.3 }
  );

  observer.observe(element);
})();

(() => {
  const element = document.getElementById('hl-roles');
  const roughNotationApi = globalThis.RoughNotation;

  if (!element || !roughNotationApi) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;

        const annotation = roughNotationApi.annotate(element, {
          type: 'highlight',
          color: 'rgba(253,224,71,0.35)',
          strokeWidth: 2,
        });

        annotation.show();
        observer.disconnect();
      });
    },
    { threshold: 0.5 }
  );

  observer.observe(element);
})();
