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
  },
  server: {
    port: 3000,
    proxy: {
      '/Icons': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/assets': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
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
