import { Center, Text3D, useTexture } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Suspense } from 'react';
import cloudTextureUrl from '@/assets/cloud.png';
import fontUrl from '@/assets/fonts/helvetiker_bold.typeface.json?url';

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

export default function Cloud404App() {
  return (
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
  );
}
