import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import tsConfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // Auth routes are handled by TanStack Start's /api/auth/$ catch-all,
        // which proxies directly to Convex. Skip them here.
        bypass: (req) => {
          if (req.url?.startsWith('/api/auth')) {
            return req.url;
          }
        },
      },
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
