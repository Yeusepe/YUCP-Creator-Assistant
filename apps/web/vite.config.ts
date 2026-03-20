import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import tsConfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Expose CONVEX_URL to client code via import.meta.env.CONVEX_URL.
  // This is a public URL (not a secret) so it's safe to embed in the client bundle.
  // The value comes from Infisical bootstrap (process.env.CONVEX_URL).
  define: {
    'import.meta.env.CONVEX_URL': JSON.stringify(process.env.CONVEX_URL),
    // Injected at build time for version skew detection (see versionPoller.ts).
    // In CI/CD, set BUILD_ID to the git SHA or pipeline run ID.
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(process.env.BUILD_ID ?? 'dev'),
  },
  server: {
    port: 3000,
  },
  preview: {
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
    host: '0.0.0.0',
  },
  ssr: {
    noExternal: ['@convex-dev/better-auth'],
  },
  plugins: [
    tsConfigPaths(),
    tailwindcss(),
    tanstackStart({
      tsr: {
        appDirectory: './src',
        autoCodeSplitting: true,
      },
    }),
    viteReact(),
  ],
  environments: {
    client: {
      build: {
        rollupOptions: {
          output: {
            manualChunks: {
              three: ['three', '@react-three/fiber', '@react-three/drei'],
            },
          },
        },
      },
    },
  },
});
