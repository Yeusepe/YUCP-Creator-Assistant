import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: false,
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'public/assets/site'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'frontend/site.tsx'),
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'site.js',
        chunkFileNames: 'site.js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.names.some((name) => name.endsWith('.css'))) {
            return 'site.css';
          }
          return 'assets/[name][extname]';
        },
      },
    },
  },
});
