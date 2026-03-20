import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react({ jsxRuntime: 'classic' }), tailwindcss()],
  publicDir: false,
  base: './',
  build: {
    outDir: path.resolve(__dirname, '../../docs/assets/index'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'frontend/docs/index.tsx'),
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'index.js',
        chunkFileNames: 'index.js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.names.some((name) => name.endsWith('.css'))) {
            return 'index.css';
          }
          return 'assets/[name][extname]';
        },
      },
    },
  },
});
