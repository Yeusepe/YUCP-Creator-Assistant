import { Clouds, Sky as SkyImpl } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useEffect } from 'react';
import * as THREE from 'three';
import cloudTextureUrl from '@/assets/cloud.png';
import { MovingCloud } from './MovingCloud';

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

function BackgroundReadySignal({ onReady }: { onReady?: () => void }) {
  useEffect(() => {
    if (!onReady) return;
    const frameId = requestAnimationFrame(() => onReady());
    return () => cancelAnimationFrame(frameId);
  }, [onReady]);

  return null;
}

export default function BackgroundApp({ onReady }: { onReady?: () => void }) {
  return (
    <Canvas
      camera={{ position: [0, -5, 15], fov: 60 }}
      gl={{ alpha: true }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
      }}
      style={{ background: 'transparent' }}
    >
      <BackgroundReadySignal onReady={onReady} />
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
  );
}
