import { Clouds } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import cloudTextureUrl from '@/assets/cloud.png';
import { MovingCloud } from './MovingCloud';

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

export default function ForegroundApp() {
  return (
    <Canvas
      camera={{ position: [0, -5, 15], fov: 60 }}
      gl={{ alpha: true }}
      style={{ pointerEvents: 'none' }}
    >
      <ForegroundSky />
      <ambientLight intensity={Math.PI / 1.5} />
      <directionalLight position={[10, 20, 10]} intensity={1.5} color="#ffffff" />
    </Canvas>
  );
}
