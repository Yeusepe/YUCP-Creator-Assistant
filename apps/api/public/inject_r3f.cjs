const fs = require('fs');
const path = require('path');

const HEAD_REPLACE = `
    <!-- ES Module Shims for better browser compatibility -->
    <script async src="https://ga.jspm.io/npm:es-module-shims@1.10.0/dist/es-module-shims.js"></script>
    <script type="importmap">
    {
        "imports": {
            "react": "https://esm.sh/react@18.2.0",
            "react-dom": "https://esm.sh/react-dom@18.2.0",
            "react-dom/client": "https://esm.sh/react-dom@18.2.0/client",
            "three": "https://esm.sh/three@0.160.0",
            "@react-three/fiber": "https://esm.sh/@react-three/fiber@8.15.12?deps=three@0.160.0,react@18.2.0,react-dom@18.2.0",
            "@react-three/drei": "https://esm.sh/@react-three/drei@9.96.1?deps=three@0.160.0,react@18.2.0,react-dom@18.2.0,@react-three/fiber@8.15.12"
        }
    }
    </script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>`;

const BODY_START_REPLACE = `>
    <div id="bg-canvas-root" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: -20; pointer-events: none;"></div>
    <div id="fg-canvas-root" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 40; pointer-events: none;"></div>`;

const BODY_END_REPLACE = `
    <script type="text/babel" data-type="module">
        import React, { useRef, Component } from "react";
        import { createRoot } from "react-dom/client";
        import * as THREE from "three";
        import { Canvas, useFrame } from "@react-three/fiber";
        import { Clouds, Cloud, Sky as SkyImpl } from "@react-three/drei";

        class ErrorBoundary extends Component {
            constructor(props) {
                super(props);
                this.state = { hasError: false, error: null };
            }
            static getDerivedStateFromError(error) { return { hasError: true, error }; }
            componentDidCatch(error, errorInfo) { console.error("React Error Boundary caught an error", error, errorInfo); }
            render() { return this.state.hasError ? null : this.props.children; }
        }

        function MovingCloud({ startX, speed, bounds, color, volume, opacity, seed, y, z, growth, fade, segments, concentrate }) {
            const ref = useRef();
            useFrame((state) => {
                if (ref.current) {
                    const elapsed = state.clock.getElapsedTime();
                    const range = 240;
                    let currentX = startX - elapsed * speed;
                    currentX = ((currentX + 120) % range + range) % range - 120;
                    ref.current.position.x = currentX;
                }
            });
            return (
                <group ref={ref} position={[startX, y, z]}>
                    <Cloud bounds={bounds} color={color} volume={volume} opacity={opacity} seed={seed} growth={growth} fade={fade} segments={segments} concentrate={concentrate} position={[0, 0, 0]} />
                </group>
            );
        }

        function BackgroundSky() {
            return (
                <React.Fragment>
                    <SkyImpl sunPosition={[100, 20, 100]} turbidity={0.8} rayleigh={0.5} />
                    <Clouds material={THREE.MeshLambertMaterial} limit={4000} range={20}>
                        <MovingCloud startX={0} speed={1.5} bounds={[25, 6, 15]} color="#ffffff" volume={15} opacity={0.6} seed={1} y={0} z={-10} growth={4} fade={10} segments={20} />
                        <MovingCloud startX={30} speed={2.2} bounds={[10, 4, 10]} color="#eaebff" volume={6} opacity={0.4} seed={2} y={8} z={-20} growth={8} fade={20} segments={10} />
                        <MovingCloud startX={-20} speed={0.5} bounds={[60, 5, 40]} color="#d3e2ff" volume={40} opacity={0.9} seed={3} y={-5} z={-35} growth={2} fade={30} segments={40} concentrate="outside" />
                        <MovingCloud startX={-45} speed={1.0} bounds={[30, 20, 30]} color="#fdfdfd" volume={35} opacity={0.7} seed={5} y={5} z={-25} growth={6} fade={15} segments={35} concentrate="random" />
                    </Clouds>
                </React.Fragment>
            )
        }

        function ForegroundSky() {
            return (
                <React.Fragment>
                    <Clouds material={THREE.MeshLambertMaterial} limit={4000} range={20}>
                        <MovingCloud startX={45} speed={2.8} bounds={[10, 10, 5]} color="#f0f0f0" volume={12} opacity={0.8} seed={4} y={2} z={10} growth={15} fade={5} segments={15} concentrate="inside" />
                        <MovingCloud startX={15} speed={3.5} bounds={[20, 5, 8]} color="#ffffff" volume={8} opacity={0.6} seed={6} y={-2} z={5} growth={5} fade={25} segments={12} />
                    </Clouds>
                </React.Fragment>
            )
        }

        function BackgroundApp() {
            return (
                <ErrorBoundary>
                    <Canvas camera={{ position: [0, -5, 15], fov: 60 }} gl={{ alpha: false }}>
                        <BackgroundSky />
                        <ambientLight intensity={Math.PI / 1.5} />
                        <directionalLight position={[10, 20, 10]} intensity={1.5} color="#ffffff" />
                        <spotLight position={[-20, 0, 10]} color="#ffdddd" angle={0.8} decay={0} penumbra={1} intensity={10} />
                    </Canvas>
                </ErrorBoundary>
            )
        }

        function ForegroundApp() {
            return (
                <ErrorBoundary>
                    <Canvas camera={{ position: [0, -5, 15], fov: 60 }} gl={{ alpha: true }} style={{ pointerEvents: 'none' }}>
                        <ForegroundSky />
                        <ambientLight intensity={Math.PI / 1.5} />
                        <directionalLight position={[10, 20, 10]} intensity={1.5} color="#ffffff" />
                    </Canvas>
                </ErrorBoundary>
            )
        }

        const bgRoot = createRoot(document.getElementById('bg-canvas-root'));
        bgRoot.render(<BackgroundApp />);

        const fgRoot = createRoot(document.getElementById('fg-canvas-root'));
        fgRoot.render(<ForegroundApp />);
    </script>
</body>`;

const files = [
    'connect.html',
    'dashboard.html',
    'discord-role-setup.html',
    'jinxxy-setup.html',
    'sign-in-redirect.html',
    'verify-error.html',
    'verify-success.html',
    'termsofservice.html'
];

files.forEach(file => {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) return;

    let content = fs.readFileSync(filePath, 'utf8');

    // Skip if already injected
    if (content.includes('bg-canvas-root')) {
        console.log(`Skipping ${file} - already injected`);
        return;
    }

    content = content.replace('</head>', HEAD_REPLACE);
    content = content.replace(/<body([^>]*)>/, '<body$1>' + BODY_START_REPLACE);
    content = content.replace('</body>', BODY_END_REPLACE);

    fs.writeFileSync(filePath, content);
    console.log(`Injected into ${file}`);
});
